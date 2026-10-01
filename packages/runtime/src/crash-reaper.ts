/**
 * Crash-detect sweep (PR-1 of the crash-detect chantier).
 *
 * Agent-cli sessions keep their adapter child alive between turns (by
 * design, for multi-turn continuity). If that child dies OUTSIDE a turn —
 * OOM-killed, segfaulted, `kill -9`'d out of band — nothing observes the
 * death: there's no turn in flight to throw, so the descriptor keeps lying
 * `status:"running"` until the next prompt's RPC fails. A parked session
 * with no next prompt never gets that chance; the crash is silent forever.
 *
 * The same is true one layer up, for a reason a pid probe can never catch:
 * an ACP wrapper's PROCESS can outlive its own JSON-RPC stream. The stream
 * ends, `process.kill(pid, 0)` keeps succeeding, and the row reports
 * `running`/`alive: true` while every prompt rejects "ACP connection
 * closed". So this pass probes BOTH axes — process liveness AND transport
 * liveness (`adapterConnected`, from the live session's `isConnected()`).
 *
 * This pass sweeps the registry, finds agent-cli sessions provably dead on
 * either axis, and MARKS them crashed (`registry.markCrashed`): flips the row to
 * `error`/`endedReason:"crashed"`, records a short `lastError`, and clears
 * the dead binding so the row stays lazy-resumable — same shape as
 * idle-reaper's `reapIdle`, except this pass is DISCOVERING a death that
 * already happened rather than causing one.
 *
 * DETECTION AND SURFACING ONLY (this PR). No auto-restart, no supervisor
 * notification — those are later PRs; see BRIEF.md.
 *
 * The crash ACTION and its invariants (agent-cli-only, running-only,
 * clear-the-binding-so-it-stays-resumable, emit `session:exited`) live
 * behind `registry.markCrashed`. This module owns only the POLICY: which
 * rows are provably dead and safe to mark.
 *
 * OFF by default: a non-positive / undefined `crashDetectIntervalMs`
 * disables the pass entirely (it returns `enabled:false` and never touches a
 * row) — same opt-in shape as idle-reaper, even though the gateway wires
 * this pass DEFAULT-ON (see index.ts) since detection is non-destructive
 * observability.
 */

import type {
  SessionCrashReason,
  SessionDescriptor,
  SessionsRegistry,
} from "./sessions.js"

/** Tally of one crash-detect sweep, for the periodic log line + tests. */
export interface CrashDetectSummary {
  /** Whether the pass actually ran. False when `crashDetectIntervalMs` is
   *  non-positive/undefined (the knob is off) — the pass short-circuits and
   *  every count is 0. Distinguishes "ran, found nothing crashed" from
   *  "disabled". */
  enabled: boolean
  /** Rows that matched the crash policy — the sweep's candidate set. */
  candidates: number
  /** Rows actually marked crashed (`markCrashed` returned true). */
  crashed: number
  /** The crashed ids, for the sweep's summary log line. */
  ids: string[]
}

/** The slice of the sessions registry the crash-detect pass needs: enumerate
 *  every row (including archived, for parity with idle-reaper's scan) and
 *  mark one crashed by id. Structural so the pass is a pure, unit-testable
 *  function decoupled from the full registry surface. */
export interface CrashReaperRegistry {
  list(opts?: { includeArchived?: boolean }): readonly SessionDescriptor[]
  markCrashed(id: string, reason?: SessionCrashReason): boolean
}

/**
 * Crash policy for one row. True iff it is a LOCAL agent-cli session that is
 * `running` and provably dead on EITHER liveness axis (see below). NEVER
 * marks:
 *   - a non-agent-cli kind (PTY/`command`/browser — those get an OS exit
 *     event, they're never silently dead);
 *   - a non-`running` row (already exited/killed/errored/starting);
 *   - a `remote` row (a sandboxed/remote session's process isn't ours to
 *     probe — neither axis is meaningful for it);
 *   - a row where NEITHER axis reports an explicit `false` (undefined means
 *     unprobed/not-applicable, true means alive — only a confirmed-dead
 *     probe is grounds to mark).
 *
 * The two axes, and why one isn't enough:
 *
 *   - PROCESS (`pid` + `processAlive === false`) — the original ground. A
 *     row with no `pid` has nothing to probe, hence the pid guard.
 *   - TRANSPORT (`adapterConnected === false`) — the adapter's JSON-RPC
 *     stream is closed. This is the gap the process axis structurally cannot
 *     close: an ACP wrapper routinely OUTLIVES its own stdio stream, so
 *     `process.kill(pid, 0)` keeps succeeding for a session that can never
 *     answer another prompt. Observed live 2026-09-25 (`sess_950d1251`,
 *     "ACP connection closed" at 15:04Z, still `running`/`alive: true` 40+
 *     minutes later). Deliberately NOT gated on `pid`: a dead transport is
 *     conclusive whether or not we know a pid, and the two axes are
 *     independent.
 */
function isCrashed(desc: SessionDescriptor): boolean {
  if (desc.kind !== "agent-cli") return false
  if (desc.status !== "running") return false
  if (desc.remote === true) return false
  if (desc.adapterConnected === false) return true
  if (desc.pid === null || desc.pid === undefined) return false
  return desc.processAlive === false
}

/** Which axis condemned this row — the `reason` handed to `markCrashed` so
 *  the crash banner names the death that was actually observed. Transport
 *  first: when both axes are dead the stream close is the more specific,
 *  more actionable fact (and it's the one that happened first). */
function crashReasonFor(desc: SessionDescriptor): SessionCrashReason {
  return desc.adapterConnected === false ? "transport-closed" : "process-gone"
}

/**
 * Run one crash-detect sweep. Pure over the registry's own freshly-probed
 * `processAlive` (stamped by `list()` at read time — no clock injection
 * needed here, unlike idle-reaper, since crash policy isn't time-based).
 * Returns the tally; the caller (the gateway's periodic ticker) turns it
 * into a one-line log per sweep.
 */
export function runCrashDetectPass(opts: {
  registry: CrashReaperRegistry
  /** Mark agent-cli sessions whose process is confirmed dead. Non-positive /
   *  undefined ⇒ the pass is DISABLED. (The gateway wires a sane default
   *  interval so this is default-on in practice — see index.ts.) */
  crashDetectIntervalMs: number | undefined
  /** Cross-process gate (mirrors idle-reaper's §5): with two daemons sharing
   *  the workspace buckets, each sweeps only rows for the workspace IT
   *  serves. Return false to exclude a row. Omitted ⇒ every row is served. */
  isServed?: (desc: SessionDescriptor) => boolean
}): CrashDetectSummary {
  const { registry, isServed } = opts
  const intervalMs = opts.crashDetectIntervalMs
  if (!intervalMs || intervalMs <= 0) {
    return { enabled: false, candidates: 0, crashed: 0, ids: [] }
  }
  // includeArchived for parity with idle-reaper's scan shape; archived rows
  // are never `running` anyway so isCrashed excludes them regardless.
  const all = registry.list({ includeArchived: true })
  const candidates = all.filter(d => (isServed?.(d) ?? true) && isCrashed(d))

  const summary: CrashDetectSummary = {
    enabled: true,
    candidates: candidates.length,
    crashed: 0,
    ids: [],
  }
  for (const d of candidates) {
    if (registry.markCrashed(d.id, crashReasonFor(d))) {
      summary.crashed++
      summary.ids.push(d.id)
    }
  }
  return summary
}
