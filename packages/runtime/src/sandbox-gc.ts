/**
 * `agentproto sandbox gc` — the orphan-box reaper.
 *
 * A sandboxed spawn that FAILS after the box was created (boot failure
 * after `provider.boot` returned, a reconnect whose daemon MCP connect
 * failed, the box's own `agent_start` rejecting, …) leaves a live box on
 * its provider with no owning session. So does a session that then died
 * (error/killed/exited) while its box idled to a PAUSED state on e2b —
 * and paused boxes still bill.
 *
 * The spawn path now reaps failed boots itself (see
 * `session-spawn.ts`), but boxes orphaned before that fix exist in the
 * ledger. The gc selects ledger entries whose ORIGIN SESSION ended in a
 * terminal-failure state (`error` / `killed` / `exited`), and — with
 * `apply` — tears the box down on its provider (kill by default; `pause`
 * keeps it attachable for boxes you still want) and stamps the ledger.
 * Dry run by default.
 */
import type { SandboxProviderBox } from "@agentproto/sandbox"
import type { SandboxProviderHandle } from "./sandbox-providers/types.js"
import type { SandboxLedgerEntry, SandboxLedgerState } from "./sandbox-ledger.js"
import { readSandboxLedger, recordSandboxState, recordSessionDetach } from "./sandbox-ledger.js"

/** Host session statuses after which a session can never use its box again. */
export const DEAD_SESSION_STATUSES: ReadonlySet<string> = new Set(["error", "killed", "exited"])

/** One ledger row selected for gc, with the observed origin-session status. */
export interface SandboxGcCandidate {
  entry: SandboxLedgerEntry
  sessionStatus: string
}

/** The lineage slice the gc needs to find a LIVE successor of an origin
 *  session. Only the predecessor links are read: inverting them covers the
 *  resume/continue/handover chain, and an inverse link (`continuedTo` /
 *  `succeededBy`) can go stale in the other direction. `sandboxTeardown` is
 *  the descriptor's recorded teardown mode; a box whose origin (or the live
 *  successor/attache that last held it) asked for `pause` is paused rather
 *  than deleted. `resumable` stays advisory only: it is true for nearly every
 *  dead agent-cli row, so it must never drive the pause decision. */
export interface SandboxGcSessionLineage {
  resumedFrom?: string
  continuedFrom?: string
  succeeds?: string
  sandboxTeardown?: "kill" | "pause"
  resumable?: boolean
}

/**
 * Whether the gc must PAUSE (never delete) a box. Reads the recorded teardown
 * of the origin descriptor, of every attached session, and of every successor
 * reachable from the origin through the resume/continue chain. Any `pause`
 * wins: pausing is recoverable, deleting is not.
 */
export function sandboxGcShouldPause(
  entry: SandboxLedgerEntry,
  lineage: ReadonlyMap<string, SandboxGcSessionLineage>,
): boolean {
  const teardownOf = (id: string | undefined): string | undefined =>
    id === undefined ? undefined : lineage.get(id)?.sandboxTeardown
  if (teardownOf(entry.originSessionId) === "pause") return true
  for (const attached of entry.attachedSessions ?? []) {
    if (attached !== entry.originSessionId && teardownOf(attached) === "pause") return true
  }
  const origin = entry.originSessionId
  if (origin === undefined) return false
  const successors = buildSuccessorIndex(lineage)
  const seen = new Set<string>([origin])
  let frontier = [...(successors.get(origin) ?? [])]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const id of frontier) {
      if (seen.has(id)) continue
      seen.add(id)
      if (teardownOf(id) === "pause") return true
      next.push(...(successors.get(id) ?? []))
    }
    frontier = next
  }
  return false
}

/** Predicate for "this status still counts as alive": any status the registry
 *  did not report is alive too (the conservative choice the attaché filter
 *  already makes). */
const isAliveStatus = (status: string | undefined): boolean =>
  status === undefined || !DEAD_SESSION_STATUSES.has(status)

/** Index every predecessor link so the descendant walk is a plain lookup. */
function buildSuccessorIndex(
  lineage: ReadonlyMap<string, SandboxGcSessionLineage>,
): Map<string, string[]> {
  const successors = new Map<string, string[]>()
  for (const [id, links] of lineage) {
    for (const predecessor of [links.resumedFrom, links.continuedFrom, links.succeeds]) {
      if (!predecessor) continue
      const children = successors.get(predecessor)
      if (children) children.push(id)
      else successors.set(predecessor, [id])
    }
  }
  return successors
}

/**
 * True when the origin has a descendant that is not dead. Walks the
 * resume/continue/handover chain breadth-first (cycle-safe), so a dead
 * intermediate hop does not hide a live grandchild. An unknown/missing
 * status counts as alive, the conservative choice, because deleting a box
 * that a live session still uses loses work.
 */
function hasLiveSuccessor(
  originSessionId: string,
  sessionStatuses: ReadonlyMap<string, string>,
  successors: ReadonlyMap<string, readonly string[]>,
): boolean {
  const seen = new Set<string>([originSessionId])
  let frontier = [...(successors.get(originSessionId) ?? [])]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const id of frontier) {
      if (seen.has(id)) continue
      seen.add(id)
      if (isAliveStatus(sessionStatuses.get(id))) return true
      next.push(...(successors.get(id) ?? []))
    }
    frontier = next
  }
  return false
}

/**
 * Select ledger entries whose origin session is error/killed/exited.
 * Rows already marked "stopped" are skipped (nothing left to tear down);
 * rows with no `originSessionId` are skipped too — their owning session
 * is unknown, so "orphan" cannot be established from this surface.
 *
 * `sessionLineage` is optional so callers that only have statuses keep
 * working; when supplied, the resume/continue chain behind the origin is
 * walked as well (the 2026-10-23 incident: a `session_restart` resumed a
 * dead origin's box under a NEW id, so the ledger origin was dead while a
 * live session still used the box).
 */
export function collectGcCandidates(
  entries: readonly SandboxLedgerEntry[],
  sessionStatuses: ReadonlyMap<string, string>,
  sessionLineage: ReadonlyMap<string, SandboxGcSessionLineage> = new Map(),
  absent: SandboxGcAbsentSessions = {},
): SandboxGcCandidate[] {
  const successors = buildSuccessorIndex(sessionLineage)
  const isDead = deadSessionPredicate(sessionStatuses, absent)
  return entries
    .filter(e => e.originSessionId !== undefined && e.state !== "stopped")
    .map(entry => ({
      entry,
      sessionStatus:
        sessionStatuses.get(entry.originSessionId as string) ??
        (isDead(entry, entry.originSessionId as string) ? ABSENT_SESSION_STATUS : undefined),
    }))
    .filter((c): c is SandboxGcCandidate & { sessionStatus: string } => c.sessionStatus !== undefined && isDead(c.entry, c.entry.originSessionId as string))
    // AIP-36 shared-box amendment — the origin session dying does not make
    // the box an orphan when OTHER sessions are still attached. Skip unless
    // every remaining attaché is itself dead (its status is terminal);
    // an unknown survivor status conservatively keeps the box alive.
    .filter(c => {
      const others = (c.entry.attachedSessions ?? []).filter(
        s => s !== c.entry.originSessionId,
      )
      if (others.length === 0) return true
      return others.every(s => isDead(c.entry, s))
    })
    // Successor sessions resumed onto the same box are not in
    // `attachedSessions` for ledger rows written before that registration
    // existed, so walk their lineage to keep an already-broken row too.
    .filter(c => !hasLiveSuccessor(c.entry.originSessionId as string, sessionStatuses, successors))
}

/** Status reported for an origin session the registry no longer knows. */
const ABSENT_SESSION_STATUS = "absent"

/**
 * Opt-in: treat a session the registry has NO row for as dead. A session that
 * was pruned, deleted or never persisted can never close its handle, so the
 * box it held (and the session slot the provider counts for it) would stay
 * reserved forever; the default keeps the conservative reading (unknown =
 * alive) for callers whose status source may not list every row. `graceMs`
 * (default 10 min) spares a ledger row touched recently: a box booted a
 * moment ago may be attached by a session the registry has not recorded yet.
 */
export interface SandboxGcAbsentSessions {
  absentSessionsAreDead?: boolean
  graceMs?: number
  now?: number
}

export const DEFAULT_ABSENT_SESSION_GRACE_MS = 10 * 60_000

/** `(entry, sessionId) => dead?` under the absent-session policy above. */
function deadSessionPredicate(
  sessionStatuses: ReadonlyMap<string, string>,
  absent: SandboxGcAbsentSessions,
): (entry: SandboxLedgerEntry, sessionId: string) => boolean {
  const now = absent.now ?? Date.now()
  const graceMs = absent.graceMs ?? DEFAULT_ABSENT_SESSION_GRACE_MS
  return (entry, sessionId) => {
    const status = sessionStatuses.get(sessionId)
    if (status !== undefined) return DEAD_SESSION_STATUSES.has(status)
    if (absent.absentSessionsAreDead !== true) return false
    const touched = Date.parse(entry.updatedAt)
    return !Number.isFinite(touched) || now - touched >= graceMs
  }
}

/** Provider resolution + ledger targeting for the reaper — injectable so
 *  tests can hand a fake provider and a tmp ledger path. */
export interface SandboxGcReapDeps {
  resolveProvider: (slug: string) => Promise<SandboxGcProviderHandle | null>
  ledgerPath?: string
}

/** The slice of `SandboxProviderHandle` the reaper needs. */
export interface SandboxGcProviderHandle {
  provider: {
    connect?(
      sandboxId: string,
      spec: { provider: string; config: Record<string, unknown> },
      opts: { env: Record<string, string> },
    ): Promise<{
      sandboxId: string
      stop(): Promise<void>
      pause?(): Promise<void>
    }>
    /** Control-plane destroy WITHOUT connecting — see `SandboxProvider.
     *  remove`. Preferred over `connect()` + `stop()`: connecting to a
     *  suspended computer RESUMES it first (RAM requirement), exactly the
     *  capacity-need that made `sandbox rm`/gc fail on an exhausted host.
     *  The gc runs AFTER its attaché candidate check, so it is the only
     *  caller allowed to `force` past a shared-box 409. Optional: providers
     *  without it fall back to the connect path. */
    remove?(sandboxId: string, opts?: { force?: boolean }): Promise<void>
    /** Release one dead session's provider-side slot without connecting
     *  (see `SandboxProvider.releaseSession`). */
    releaseSession?(sandboxId: string, holder: string): Promise<void>
    /** Control-plane enumeration of the provider's boxes: the orphan-box
     *  gc reads it to find boxes no live session holds (see
     *  `sandbox-orphan-gc.ts`). */
    listBoxes?(): Promise<SandboxProviderBox[]>
  }
}

/** Error-message shapes meaning "the box is already gone" — an idempotent
 *  successful gc, never a failure. The bare `not found` spelling is NOT
 *  matched on its own: an unrelated error like `provider "x" not found`
 *  must never be stamped as a successful reap. Prefer the typed sentinel
 *  (`SandboxBoxGoneError`, via {@link isGoneError}); the message regex is
 *  the fallback for providers without one. */
export const GONE_RE =
  /\b404\b|doesn't exist|does not exist|no longer exists|no such|box gone|box is gone|(box|sandbox|computer)\s+not found/i

/** Structural check — true when `err` means "the box is gone" (the typed
 *  sentinel or any Error carrying its name). */
export function isGoneError(err: unknown): boolean {
  return err instanceof Error && err.name === "SandboxBoxGoneError"
}

export type SandboxGcReapResult =
  | { ok: true; action: "paused" | "stopped" }
  | { ok: false; error: string }

/**
 * Tear one ledger entry's box down on its provider and stamp the ledger.
 * `pause` keeps the box (pausing when the provider supports it, falling
 * back to a kill otherwise); the default kills. A connect failure that
 * reads as "box doesn't exist anymore" still stamps the row "stopped" so
 * the candidate stops re-appearing; other failures leave the row alone
 * (transient network must not mark a live box as reaped).
 */
export async function reapGcEntry(
  entry: SandboxLedgerEntry,
  opts: { pause?: boolean } & SandboxGcReapDeps,
): Promise<SandboxGcReapResult> {
  let handle: SandboxGcProviderHandle | null
  try {
    handle = await opts.resolveProvider(entry.provider)
  } catch (err) {
    return {
      ok: false,
      error: `provider "${entry.provider}" could not be resolved — ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
  if (!handle) return { ok: false, error: `provider "${entry.provider}" not found.` }
  // CAPACITY-FREE TEARDOWN: when the provider can destroy the box straight
  // on its control plane, never `connect()` first — connecting to a
  // suspended computer RESUMES it (RAM), requiring the capacity gc is meant
  // to free. `pause` keeps the connect path: pausing needs the handle's
  // lifecycle call. An id-already-gone outcome is a NO-OP success.
  if (opts.pause !== true && handle.provider.remove) {
    try {
      // ALREADY FORCED ON PURPOSE: the pass only picked this row because
      // every attaché's session status is terminal (collectGcCandidates),
      // so no live session can be surprised by the force.
      await handle.provider.remove(entry.sandboxId, { force: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (GONE_RE.test(message) || isGoneError(err)) {
        recordSandboxState(entry.sandboxId, "stopped", opts.ledgerPath)
        return { ok: true, action: "stopped" }
      }
      return { ok: false, error: `removing "${entry.sandboxId}" failed — ${message}` }
    }
    recordSandboxState(entry.sandboxId, "stopped", opts.ledgerPath)
    return { ok: true, action: "stopped" }
  }
  if (!handle.provider.connect) {
    return {
      ok: false,
      error: `provider "${entry.provider}" has no connect() — cannot reach the existing box.`,
    }
  }
  let booted: Awaited<ReturnType<NonNullable<typeof handle.provider.connect>>>
  try {
    booted = await handle.provider.connect(
      entry.sandboxId,
      { provider: entry.provider, config: {} },
      { env: {} },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Use the shared gone-detection (the typed `SandboxBoxGoneError` plus the
    // message fallback): a provider whose reconnect says "no longer exists"
    // must stamp the row stopped, not fail every pass forever.
    if (GONE_RE.test(message) || isGoneError(err)) {
      recordSandboxState(entry.sandboxId, "stopped", opts.ledgerPath)
      return { ok: true, action: "stopped" }
    }
    return { ok: false, error: `connect to "${entry.sandboxId}" failed — ${message}` }
  }
  const action: "paused" | "stopped" =
    opts.pause === true && booted.pause ? "paused" : "stopped"
  try {
    if (action === "paused") await booted.pause!()
    else await booted.stop()
  } catch (err) {
    return {
      ok: false,
      error: `tearing down "${entry.sandboxId}" failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
  recordSandboxState(entry.sandboxId, action, opts.ledgerPath)
  return { ok: true, action }
}

/** States that still name a box the gc might act on. */
export const GC_REAPABLE_STATES: readonly SandboxLedgerState[] = ["booted", "connected", "paused"]

/** How long the periodic pass keeps a paused dead-session row before reaping
 *  it anyway. Thirty minutes is long enough for an operator to notice and
 *  reconnect, short enough that a forgotten paused box cannot hold a host's
 *  memory budget all night (2026-10-29: a paused box held 12 GB and every new
 *  create was refused until it vanished an hour later). */
export const DEFAULT_PAUSED_BOX_MAX_AGE_MS = 30 * 60_000

/** Parse the `AGENTPROTO_SANDBOX_GC_PAUSED_MAX_AGE_MS` env knob. Unset or
 *  non-numeric falls back to {@link DEFAULT_PAUSED_BOX_MAX_AGE_MS}; an
 *  explicit `0` reaps every paused row on the next pass. */
export function parsePausedBoxMaxAge(
  raw: string | undefined,
  fallback: number = DEFAULT_PAUSED_BOX_MAX_AGE_MS,
): number {
  const parsed = raw === undefined || raw.trim() === "" ? NaN : Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback
}
/** Sources a session-status READ for the periodic gc. Injected so the
 *  daemon pass reads its OWN registry and the CLI keeps its HTTP one. */
export interface SandboxGcReadDeps {
  fetchSessionStatuses: () => Promise<Map<string, string>> | Map<string, string>
  /** Predecessor lineage + resume eligibility per session. Optional: without
   *  it the pass falls back to the attaché filter only. */
  fetchSessionLineage?: () =>
    | Promise<ReadonlyMap<string, SandboxGcSessionLineage>>
    | ReadonlyMap<string, SandboxGcSessionLineage>
  resolveProvider: (slug: string) => Promise<SandboxGcProviderHandle | null>
  ledgerPath?: string
  /** The daemon pass reads its own full registry, so a session it has no row
   *  for is gone for good (see {@link SandboxGcAbsentSessions}). Leave unset
   *  for a status source that may omit live rows. */
  absentSessionsAreDead?: boolean
  /** How long a paused row may sit before the pass reaps it regardless of a
   *  `pause` teardown. A paused box holds provider capacity (RAM snapshot) and
   *  is not attachable by a new spawn once its session is gone, so "kept
   *  paused forever" is a leak. Defaults to
   *  {@link DEFAULT_PAUSED_BOX_MAX_AGE_MS}; `0` reaps every paused row. */
  pausedMaxAgeMs?: number
}

/** Tally of one automatic gc pass. */
export interface SandboxGcPassSummary {
  ran: boolean
  candidates: number
  stopped: number
  paused: number
  /** Rows already paused on the ledger: skipped with no provider call. */
  kept: number
  failures: number
  /** Dead sessions whose slot on a box that stays in use was released.
   *  Present only when at least one was. */
  released?: number
}

/**
 * One automatic `sandbox gc` pass: read the session statuses, select the
 * ledger rows whose origin session is DEAD (error/killed/exited —
 * {@link collectGcCandidates}) and reap them with {@link reapGcEntry}.
 * Unlike the CLI's dry-run-first command, the daemon pass applies by
 * default (the operator chose to run a daemon; orphan boxes bill while
 * nobody looks at them), but a failure is always logged, never thrown.
 */
export async function runSandboxGcPass(
  deps: SandboxGcReadDeps,
  log: (line: string) => void = () => undefined,
): Promise<SandboxGcPassSummary> {
  const statuses = await deps.fetchSessionStatuses()
  const lineage = deps.fetchSessionLineage ? await deps.fetchSessionLineage() : new Map()
  const absent: SandboxGcAbsentSessions = deps.absentSessionsAreDead
    ? { absentSessionsAreDead: true }
    : {}
  const ledger = readSandboxLedger(deps.ledgerPath)
  const candidates = collectGcCandidates(ledger, statuses, lineage, absent)
  const pausedMaxAgeMs = deps.pausedMaxAgeMs ?? DEFAULT_PAUSED_BOX_MAX_AGE_MS
  const now = Date.now()
  const summary: SandboxGcPassSummary = {
    ran: true,
    candidates: candidates.length,
    stopped: 0,
    paused: 0,
    kept: 0,
    failures: 0,
  }
  for (const candidate of candidates) {
    // Honour the session's recorded teardown: a `pause` teardown keeps the
    // box pausable, never deletes it (2026-10-23: the row asked for pause and
    // the pass deleted it). A kill/unset teardown still deletes, as before.
    const pause = sandboxGcShouldPause(candidate.entry, lineage)
    // A paused row older than the bound is NOT kept: the session is gone and
    // the snapshot holds provider capacity nobody will reconnect to. Reap it
    // with the default (kill) path so a paused box cannot live forever.
    const pausedAgeMs = now - Date.parse(candidate.entry.updatedAt)
    const expiredPaused =
      candidate.entry.state === "paused" &&
      pause &&
      (!Number.isFinite(pausedAgeMs) || pausedAgeMs >= pausedMaxAgeMs)
    // An already paused row whose teardown is pause needs no provider call:
    // pausing it again every interval is a round-trip for no state change.
    // A paused row whose teardown is kill/unset is still reaped below, so
    // paused boxes do not leak forever.
    if (candidate.entry.state === "paused" && pause && !expiredPaused) {
      summary.kept++
      log(
        `sandbox gc: ${candidate.entry.sandboxId} kept paused (session ${candidate.entry.originSessionId} ${candidate.sessionStatus})`,
      )
      continue
    }
    if (expiredPaused) {
      log(
        `sandbox gc: ${candidate.entry.sandboxId} paused for ${Math.max(0, pausedAgeMs)}ms ` +
          `(bound ${pausedMaxAgeMs}ms) — reaping instead of keeping it`,
      )
    }
    const res = await reapGcEntry(candidate.entry, {
      ...(pause && !expiredPaused ? { pause: true } : {}),
      resolveProvider: deps.resolveProvider,
      ...(deps.ledgerPath !== undefined ? { ledgerPath: deps.ledgerPath } : {}),
    })
    if (res.ok) {
      if (res.action === "paused") summary.paused++
      else summary.stopped++
      log(
        `sandbox gc: ${candidate.entry.sandboxId} ${res.action} (session ${candidate.entry.originSessionId} ${candidate.sessionStatus})`,
      )
    } else {
      summary.failures++
      log(`sandbox gc: failed for ${candidate.entry.sandboxId} — ${res.error}`)
    }
  }
  const released = await releaseDeadAttachers(
    ledger,
    new Set(candidates.map(c => c.entry.sandboxId)),
    statuses,
    absent,
    deps,
    log,
  )
  if (released > 0) summary.released = released
  return summary
}

/**
 * Boxes that stay in use (a live session still holds them) can still carry
 * attachés that died without closing their handle: each one keeps a slot the
 * provider counts against the box's session cap and a ledger attaché that
 * blocks the box's eventual teardown. Release those slots (provider first,
 * ledger only once the provider let go) so a dead session never pins a box.
 */
async function releaseDeadAttachers(
  ledger: readonly SandboxLedgerEntry[],
  reaped: ReadonlySet<string>,
  statuses: ReadonlyMap<string, string>,
  absent: SandboxGcAbsentSessions,
  deps: SandboxGcReadDeps,
  log: (line: string) => void,
): Promise<number> {
  const isDead = deadSessionPredicate(statuses, absent)
  let released = 0
  for (const entry of ledger) {
    if (reaped.has(entry.sandboxId) || entry.state === "stopped" || entry.state === "gone") continue
    const dead = (entry.attachedSessions ?? []).filter(id => isDead(entry, id))
    if (dead.length === 0) continue
    let handle: SandboxGcProviderHandle | null = null
    try {
      handle = await deps.resolveProvider(entry.provider)
    } catch {
      continue
    }
    for (const sessionId of dead) {
      try {
        await handle?.provider.releaseSession?.(entry.sandboxId, sessionId)
      } catch (err) {
        log(
          `sandbox gc: could not release ${sessionId}'s slot on ${entry.sandboxId} — ` +
            (err instanceof Error ? err.message : String(err)),
        )
        continue
      }
      recordSessionDetach(entry.sandboxId, sessionId, deps.ledgerPath)
      released++
      log(`sandbox gc: released dead session ${sessionId}'s slot on ${entry.sandboxId}`)
    }
  }
  return released
}

/**
 * The daemon's PERIODIC automatic gc for dead-session boxes. Every
 * `intervalMs` (default {@link DEFAULT_SANDBOX_GC_INTERVAL_MS}) the pass
 * reaps ledger boxes whose origin session is gone — a paused computer
 * holding a RAM snapshot, a surviving-but-billing e2b box whose session
 * crashed and whose owner never ran `sandbox gc --apply`.
 * `.unref()` — the timer never keeps the process alive. Returns a handle
 * whose `stop()` kills the timer (the gateway's `stop()` calls it).
 */
export const DEFAULT_SANDBOX_GC_INTERVAL_MS = 60 * 60_000
export interface SandboxGcTimer {
  stop(): void
}

/**
 * Parse the `AGENTPROTO_SANDBOX_GC_INTERVAL_MS` env knob. Unset (or
 * non-numeric) falls back to the default; an explicit `0` or a negative
 * value DISABLES the timer (`0` returned) — the sweep is destructive, so
 * operators must have a working off-switch.
 */
export function parseSandboxGcInterval(
  raw: string | undefined,
  fallback: number = DEFAULT_SANDBOX_GC_INTERVAL_MS,
): number {
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback
}

export function startSandboxGcTimer(
  deps: SandboxGcReadDeps & {
    intervalMs?: number
    /** Run one pass this long after start, so sessions a dead daemon left
     *  attached are released on the first boot instead of up to an interval
     *  later. Unset: first pass after `intervalMs`, as before. */
    initialDelayMs?: number
    log?: (line: string) => void
  },
): SandboxGcTimer {
  const intervalMs = deps.intervalMs ?? DEFAULT_SANDBOX_GC_INTERVAL_MS
  const log = deps.log ?? (line => console.log(line))
  let running = false
  const tick = (): void => {
    if (running) return
    running = true
    void (async () => {
      try {
        const summary = await runSandboxGcPass(deps, log)
        if (summary.candidates > 0) {
          log(
            `sandbox gc: ${summary.candidates} dead-session box(es) — ` +
              `${summary.stopped} stopped, ${summary.paused} paused, ${summary.kept} kept, ${summary.failures} failed`,
          )
        }
      } catch (err) {
        log(`sandbox gc: pass failed — ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        running = false
      }
    })()
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  const initial =
    deps.initialDelayMs !== undefined ? setTimeout(tick, Math.max(0, deps.initialDelayMs)) : undefined
  initial?.unref?.()
  return {
    stop: () => {
      clearInterval(timer)
      if (initial) clearTimeout(initial)
    },
  }
}
