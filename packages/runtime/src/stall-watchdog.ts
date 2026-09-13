/**
 * Turn-liveness watchdog (turn-liveness-watchdog chantier).
 *
 * Agent-cli sessions report `status:"running"` for the entire life of a
 * turn, and nothing else observes the adapter's event stream directly. When
 * that stream dies mid-turn — a network drop, a hung child, zero frames
 * ever again — nothing throws: there's no RPC failure to catch, just
 * silence. The descriptor keeps lying `status:"running"`, `lastError:null`,
 * `blockedOn:undefined` — identical to a session doing genuine, healthy
 * long work. A supervisor only catches it by manually comparing
 * `lastActivityAt` to the clock (the live incident this chantier exists
 * for: `sess_0b94542f`, `lastActivityAt` frozen 36 minutes into a turn with
 * no other signal).
 *
 * This pass sweeps the registry, finds agent-cli sessions that are BUSY
 * (mid-turn), NOT legitimately `blockedOn` a subagent/command (a real
 * long-running tool call is expected to go quiet — that's not the failure
 * mode this catches), and silent past a threshold, and FLAGS them
 * (`registry.markStalled`): stamps `stalledSinceMs` and emits
 * `session:stalled` — same shape discipline as `crash-reaper.ts` /
 * `idle-reaper.ts`, except conservative by design: a `blockedOn` row is
 * NEVER a candidate, no matter how long it's been silent, because a slow
 * build and a dead stream are indistinguishable from `lastActivityAt`
 * alone once a tool call is legitimately in flight. The predicate is
 * deliberately biased toward missing a genuinely-dead-but-blocked stream
 * over false-positiving a healthy long tool call.
 *
 * DETECTION AND SURFACING ONLY. No auto-kill, no auto-restart — those are
 * later work, if ever; see AGENTS.md's "definition of done" for why this
 * pass stops at a signal.
 *
 * The trip/clear ACTIONS and their invariants (agent-cli-only, running-only,
 * busy-only, unblocked-only, idempotent, emit `session:stalled` /
 * `session:stall-cleared`) live behind `registry.markStalled` /
 * `registry.clearStalled`. This module owns only the POLICY: which rows have
 * gone silent long enough mid-turn to be worth flagging. Clearing on
 * recovery is event-driven (pulseActivity / turn start / turn finally in
 * sessions.ts), NOT this sweep's job — the sweep only ever adds the flag,
 * it never removes one, so a row already flagged is simply excluded from
 * the next sweep's candidate set until something clears it.
 *
 * OFF by default in the sense that a non-positive / undefined
 * `turnStallAfterMs` disables the pass entirely (it returns `enabled:false`
 * and never touches a row) — same opt-in shape as crash-detect and
 * idle-reap. Like crash-detect, the gateway wires a sane default threshold
 * so this is DEFAULT-ON in practice (see index.ts): detection is
 * non-destructive observability, so the bar for shipping it enabled is
 * lower than for anything that touches a live process.
 */

import type { SessionDescriptor, SessionsRegistry } from "./sessions.js"

/** Tally of one stall-watchdog sweep, for the periodic log line + tests. */
export interface StallWatchdogSummary {
  /** Whether the pass actually ran. False when `turnStallAfterMs` is
   *  non-positive/undefined (the knob is off) — the pass short-circuits and
   *  every count is 0. Distinguishes "ran, found nothing stalled" from
   *  "disabled". */
  enabled: boolean
  /** Rows that matched the stall policy — the sweep's candidate set. */
  candidates: number
  /** Rows actually flagged stalled (`markStalled` returned true). */
  stalled: number
  /** The flagged ids, for the sweep's summary log line. */
  ids: string[]
}

/** The slice of the sessions registry the watchdog needs: enumerate every
 *  row (including archived, for parity with idle-reaper's / crash-detect's
 *  scan shape; archived rows are never `running` anyway so the predicate
 *  excludes them regardless) and flag one stalled by id. Structural so the
 *  pass is a pure, unit-testable function decoupled from the full registry
 *  surface. */
export interface StallWatchdogRegistry {
  list(opts?: { includeArchived?: boolean }): readonly SessionDescriptor[]
  markStalled(id: string, stalledSinceMs: number): boolean
}

/** Epoch ms of a row's last known activity — `lastActivityAt`, falling back
 *  to `startedAt` for a fresh turn that hasn't pulsed yet. `null` when the
 *  timestamp is missing/unparseable — an un-ageable row is never flagged
 *  (we can't prove it's been silent). */
function lastActivityMsOf(desc: SessionDescriptor): number | null {
  const tsStr = desc.lastActivityAt ?? desc.startedAt
  const ts = tsStr ? Date.parse(tsStr) : Number.NaN
  return Number.isFinite(ts) ? ts : null
}

/**
 * Stall policy for one row. True iff it is a LOCAL agent-cli session that is
 * mid-turn AND not legitimately blocked AND silent past the threshold AND
 * not already flagged. NEVER flags:
 *   - a non-agent-cli kind (PTY/`command`/browser — those have no adapter
 *     event stream to go silent on in this sense);
 *   - a non-`running` row (already exited/killed/errored/starting);
 *   - a row that isn't `busy` (no turn in flight — silence is just idle);
 *   - a row with `blockedOn` set — a spawned subagent or a shell/terminal
 *     command legitimately runs long and silent; this is exactly the "long
 *     build" false-positive the predicate is designed to never trip on;
 *   - a row already carrying `stalledSinceMs` — the sweep only ever ADDS
 *     the flag, clearing is event-driven (see the module docblock), so a
 *     row already flagged simply isn't a candidate again until something
 *     clears it;
 *   - a row whose last-activity timestamp can't be parsed (nothing to age).
 */
function isStallCandidate(
  desc: SessionDescriptor,
  nowMs: number,
  thresholdMs: number,
): boolean {
  if (desc.kind !== "agent-cli") return false
  if (desc.status !== "running") return false
  if (desc.busy !== true) return false
  if (desc.blockedOn !== undefined) return false
  if (desc.stalledSinceMs !== undefined) return false
  const lastMs = lastActivityMsOf(desc)
  if (lastMs === null) return false
  return nowMs - lastMs > thresholdMs
}

/**
 * Run one stall-watchdog sweep. Pure over the injected `now` (ms epoch), so
 * a test pins a fake clock and asserts deterministically. Returns the
 * tally; the caller (the gateway's periodic ticker) turns it into a
 * one-line log per sweep.
 */
export function runStallWatchdogPass(opts: {
  registry: StallWatchdogRegistry
  /** Flag agent-cli sessions mid-turn and silent longer than this many ms.
   *  Non-positive / undefined ⇒ the pass is DISABLED. (The gateway wires a
   *  sane default so this is default-on in practice — see index.ts.) */
  turnStallAfterMs: number | undefined
  /** Injected clock (ms since epoch). Defaults to `Date.now`. */
  now?: () => number
  /** Cross-process gate (mirrors idle-reaper's / crash-detect's §5): with
   *  two daemons sharing the workspace buckets, each sweeps only rows for
   *  the workspace IT serves. Return false to exclude a row. Omitted ⇒
   *  every row is served. */
  isServed?: (desc: SessionDescriptor) => boolean
}): StallWatchdogSummary {
  const { registry, isServed } = opts
  const thresholdMs = opts.turnStallAfterMs
  if (!thresholdMs || thresholdMs <= 0) {
    return { enabled: false, candidates: 0, stalled: 0, ids: [] }
  }
  const nowMs = opts.now ? opts.now() : Date.now()
  // includeArchived for parity with idle-reaper's/crash-detect's scan
  // shape; archived rows are never `running` anyway so isStallCandidate
  // excludes them regardless.
  const all = registry.list({ includeArchived: true })
  const candidates = all.filter(
    d => (isServed?.(d) ?? true) && isStallCandidate(d, nowMs, thresholdMs),
  )

  const summary: StallWatchdogSummary = {
    enabled: true,
    candidates: candidates.length,
    stalled: 0,
    ids: [],
  }
  for (const d of candidates) {
    // lastActivityMsOf is non-null here (isStallCandidate already required
    // it) — that's the instant the trip is dated FROM, not `nowMs`, so a
    // consumer can compute "silent for" honestly.
    const lastMs = lastActivityMsOf(d) ?? nowMs
    if (registry.markStalled(d.id, lastMs)) {
      summary.stalled++
      summary.ids.push(d.id)
    }
  }
  return summary
}
