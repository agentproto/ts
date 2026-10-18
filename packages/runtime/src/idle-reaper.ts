/**
 * Idle agent-session reaper (PR-6).
 *
 * Agent-cli sessions keep their `claude-agent-acp` child alive between turns
 * (by design, for multi-turn continuity). But a finished/idle session sits
 * there as `status:"running"` indefinitely — a live adapter process holding
 * memory, cluttering `session_list`, and (once #638's eager resume-on-boot is
 * enabled) a candidate for a pointless resume-storm of dead work on the next
 * daemon restart.
 *
 * This pass sweeps the registry, finds agent-cli sessions that have been idle
 * past a threshold, and REAPS them (`registry.reapIdle`): SIGTERM the adapter
 * child to free the process, flip the row to `killed`/`endedReason:"idle-reaped"`
 * — leaving it dead-but-lazy-resumable (a later prompt revives it in place). A
 * reaped row is naturally excluded from #638's eager pass (which gates on
 * `endedReason === "daemon-restart"`), so eager resume only ever revives
 * genuinely-recent work.
 *
 * The reap ACTION and its invariants (agent-cli-only, running-only,
 * clear-the-binding-so-it-stays-resumable, emit `session:reaped`) live behind
 * `registry.reapIdle`. This module owns only the POLICY: which rows are idle
 * enough and safe to reap.
 *
 * OFF by default: a non-positive / undefined `idleReapAfterMs` disables the pass
 * entirely (it returns `enabled:false` and never touches a row) — the same
 * opt-in shape as eager resume-on-boot.
 *
 * SANDBOXED sessions (a box on a metered provider — e2b, …) get their own,
 * shorter threshold, `sandboxIdleReapAfterMs`: a finished turn never closes
 * the session, so an idle box otherwise lives until its provider lifetime
 * expires (observed: a dozen 4 vCPU / 8 GB boxes idling after finished
 * turns). Reaping such a row closes its `SandboxAgentSessionProxy`, which takes
 * a final checkpoint of the box's work and tears the box down per its
 * lifecycle policy (kill unless the spec asked to pause). A sandboxed row
 * counts as idle only when it is ALSO not blocked on a command/sub-agent/
 * background task and has no live child session. A non-sandbox session keeps
 * the general `idleReapAfterMs` rules unchanged.
 */

import { isProviderBoxSession as isBoxSession, type SessionDescriptor, type SessionsRegistry } from "./sessions.js"

/** Tally of one idle-reap sweep, for the periodic log line + tests. */
export interface IdleReapSummary {
  /** Whether the pass actually ran. False when `idleReapAfterMs` is
   *  non-positive/undefined (the knob is off) — the pass short-circuits and
   *  every count is 0. Distinguishes "ran, found nothing idle" from "disabled". */
  enabled: boolean
  /** Rows that matched the reap policy — the sweep's candidate set. */
  candidates: number
  /** Rows actually reaped (`reapIdle` returned true). */
  reaped: number
  /** The reaped ids, for the sweep's summary log line. */
  ids: string[]
}

/** The slice of the sessions registry the reaper needs: enumerate every row
 *  (including archived, so a depth>0 child's parent is reachable even if the
 *  parent was archived) and reap one by id. Structural so the pass is a pure,
 *  unit-testable function decoupled from the full registry surface — same shape
 *  discipline as `OrphanReaperRegistry`. */
export interface IdleReaperRegistry {
  list(opts?: { includeArchived?: boolean }): readonly SessionDescriptor[]
  reapIdle(id: string, idleMs?: number): boolean
}

/** How long (ms) a session has been idle, from its last observed activity
 *  (`lastActivityAt`, falling back to `startedAt`) to `nowMs`. `null` when the
 *  timestamp is missing/unparseable — an un-ageable row is never reaped (we
 *  can't prove it's old). */
function idleMsOf(desc: SessionDescriptor, nowMs: number): number | null {
  const tsStr = desc.lastActivityAt ?? desc.startedAt
  const ts = tsStr ? Date.parse(tsStr) : Number.NaN
  if (!Number.isFinite(ts)) return null
  return nowMs - ts
}

/** Default `daemon.sandboxIdleReapAfterMs`: a sandboxed session idle this long
 *  loses its box (15 min). Unlike the general knob this one is ON by default —
 *  an idle box is a billed 4 vCPU / 8 GB VM, and the reaped session stays
 *  revivable on a fresh box. */
export const DEFAULT_SANDBOX_IDLE_REAP_AFTER_MS = 15 * 60_000

/** Minimum idle span before a RESTARTED sandbox session (`continuedFrom` /
 *  `resumedFrom` set) that has shown no activity yet is reaped. A restart
 *  parks the successor on the existing box awaiting its first prompt, and the
 *  box holds the prior session's uncommitted work: reaping it on the ordinary
 *  15-minute clock (counted from `startedAt`) tore that box down before anyone
 *  could prompt it (observed 2026-10-18). */
export const SANDBOX_RESTART_REAP_GRACE_MS = 60 * 60_000

/** The two idle thresholds (ms); a non-positive / undefined one is off. */
interface ReapThresholds {
  general: number | undefined
  sandbox: number | undefined
}

const positive = (ms: number | undefined): number | undefined =>
  typeof ms === "number" && ms > 0 ? ms : undefined

/** The threshold that applies to this row: a sandboxed row takes the shorter
 *  of the sandbox and general thresholds that are enabled; any other row only
 *  the general one. `undefined` ⇒ no rule reaps this row. */
function thresholdFor(desc: SessionDescriptor, t: ReapThresholds): number | undefined {
  if (!isBoxSession(desc)) return t.general
  if (t.sandbox === undefined) return t.general
  return t.general === undefined ? t.sandbox : Math.min(t.sandbox, t.general)
}

/** Work the box is still doing that `busy` doesn't show: a command or
 *  sub-agent the turn is blocked on, a running background task, or a live
 *  child session spawned from this one. */
function isSandboxWorkInFlight(
  desc: SessionDescriptor,
  byId: ReadonlyMap<string, SessionDescriptor>,
): boolean {
  if (desc.blockedOn !== undefined) return true
  if (desc.backgroundTasks?.some(t => t.status === "running" || t.status === "paused")) return true
  for (const other of byId.values()) {
    if (
      other.parentSessionId === desc.id &&
      (other.status === "running" || other.status === "starting")
    ) {
      return true
    }
  }
  return false
}

/**
 * Reap policy for one row. True iff it is an agent-cli session that is
 * genuinely idle and safe to retire. NEVER reaps:
 *   - a non-agent-cli kind (PTY/`command`/browser — a PTY is raw screen state,
 *     a command is a one-shot; neither is resumable);
 *   - a non-`running` row (already exited/killed/errored/starting);
 *   - a busy session (a turn is in flight) or one awaiting a human
 *     (conversational input OR a parked permission decision);
 *   - an archived row (housekeeping already retired it);
 *   - a `keepAlive:true` row — the session opted itself out of the reaper (a
 *     supervisor legitimately parked waiting on a child/scheduled wake looks
 *     idle but isn't finished);
 *   - a row younger than the threshold, or one we can't age; a restarted
 *     sandbox session still awaiting its first prompt gets
 *     {@link SANDBOX_RESTART_REAP_GRACE_MS} instead;
 *   - a depth>0 sub-agent whose parent is still alive — reaping it would orphan
 *     an active orchestration mid-flight.
 */
function isReapable(
  desc: SessionDescriptor,
  nowMs: number,
  thresholds: ReapThresholds,
  byId: ReadonlyMap<string, SessionDescriptor>,
): boolean {
  if (desc.kind !== "agent-cli") return false
  if (desc.status !== "running") return false
  if (desc.busy === true) return false
  if (desc.awaitingInput === true) return false
  if (desc.awaitingPermission === true) return false
  if (desc.archived === true) return false
  if (desc.keepAlive === true) return false
  const sandboxed = isBoxSession(desc)
  if (sandboxed && isSandboxWorkInFlight(desc, byId)) return false
  let thresholdMs = thresholdFor(desc, thresholds)
  if (thresholdMs === undefined) return false
  if (
    sandboxed &&
    desc.lastActivityAt === undefined &&
    (desc.continuedFrom !== undefined || desc.resumedFrom !== undefined)
  ) {
    thresholdMs = Math.max(thresholdMs, SANDBOX_RESTART_REAP_GRACE_MS)
  }
  const idle = idleMsOf(desc, nowMs)
  if (idle === null || idle < thresholdMs) return false
  // Don't orphan an active orchestration: a spawned sub-agent whose parent is
  // still running/starting stays, even if idle itself — the parent may be
  // about to prompt it. A gone/terminal parent leaves the child fair game.
  if (desc.parentSessionId) {
    const parent = byId.get(desc.parentSessionId)
    if (parent && (parent.status === "running" || parent.status === "starting")) {
      return false
    }
  }
  return true
}

/**
 * Run one idle-reap sweep. Pure over the injected `now` (ms epoch), so a test
 * pins a fake clock and asserts deterministically. Returns the tally; the
 * caller (the gateway's periodic ticker) turns it into a one-line log per
 * sweep.
 */
export function runIdleReapPass(opts: {
  registry: IdleReaperRegistry
  /** Reap agent-cli sessions idle longer than this many ms. Non-positive /
   *  undefined ⇒ this rule is OFF (the pass as a whole is disabled only when
   *  `sandboxIdleReapAfterMs` is off too). */
  idleReapAfterMs: number | undefined
  /** Shorter threshold for SANDBOXED sessions (see module doc). Non-positive /
   *  undefined ⇒ sandboxed rows fall back to `idleReapAfterMs`. When both are
   *  on, a sandboxed row is reaped at the shorter one. */
  sandboxIdleReapAfterMs?: number
  /** Injected clock (ms since epoch). Defaults to `Date.now`. */
  now?: () => number
  /** Cross-process gate (mirrors the eager pass §5): with two daemons sharing
   *  the workspace buckets, each reaps only rows for the workspace IT serves.
   *  Return false to exclude a row. Omitted ⇒ every row is served. */
  isServed?: (desc: SessionDescriptor) => boolean
}): IdleReapSummary {
  const { registry, isServed } = opts
  const thresholds: ReapThresholds = {
    general: positive(opts.idleReapAfterMs),
    sandbox: positive(opts.sandboxIdleReapAfterMs),
  }
  // Off by default (opt-in): with neither threshold set the sweep is disabled.
  // Lazy resume + everything else is unaffected; this only controls the
  // automatic retirement of idle sessions.
  if (thresholds.general === undefined && thresholds.sandbox === undefined) {
    return { enabled: false, candidates: 0, reaped: 0, ids: [] }
  }
  const nowMs = opts.now ? opts.now() : Date.now()
  // includeArchived so a depth>0 child's archived parent is still reachable in
  // `byId` (an archived parent is terminal ⇒ the child is reapable). Archived
  // rows themselves are excluded from candidacy by `isReapable`.
  const all = registry.list({ includeArchived: true })
  const byId = new Map<string, SessionDescriptor>(all.map(d => [d.id, d]))
  const candidates = all.filter(
    d => (isServed?.(d) ?? true) && isReapable(d, nowMs, thresholds, byId),
  )

  const summary: IdleReapSummary = {
    enabled: true,
    candidates: candidates.length,
    reaped: 0,
    ids: [],
  }
  for (const d of candidates) {
    // idleMsOf is non-null here (isReapable already required it). Pass the idle
    // span through so `session:reaped` carries it for observability.
    const idle = idleMsOf(d, nowMs) ?? 0
    if (registry.reapIdle(d.id, idle)) {
      summary.reaped++
      summary.ids.push(d.id)
    }
  }
  return summary
}
