/**
 * Restart scheduler (PR-2 of the crash-detect chantier).
 *
 * PR-1 (`crash-reaper.ts`) only DETECTS a dead adapter process and surfaces
 * it (`endedReason:"crashed"`). Nothing brings the session back — it sits
 * there, lazy-resumable, until a human or orchestrator happens to prompt it.
 * This module adds an OPT-IN policy (`SessionDescriptor.restartPolicy`) that
 * proactively revives an eligible death with exponential backoff and a
 * rolling-window crash-loop cap, reusing the SAME in-place resume machinery
 * lazy resume-on-prompt uses (`maybeResumeAgent`, exposed here as
 * `registry.triggerResume`) — same session id, same conversation, no
 * reinvented revival path.
 *
 * Hybrid design, split across two independently-testable halves:
 *   - EVENT-driven SCHEDULING: `createRestartScheduler` subscribes to
 *     `session:exited`. On an eligible death it evaluates the backoff/
 *     crash-loop-cap policy (`evaluateRestartDecision`) and either stamps a
 *     `nextRestartAt` landing time (`registry.applyRestartSchedule`) or gives
 *     up (`registry.giveUpRestart`) — never touches the adapter itself.
 *   - SWEEP-driven EXECUTION: `runRestartSweepPass`, a `.unref()`'d periodic
 *     tick (wired in `index.ts`, mirroring `crash-reaper.ts`/`idle-reaper.ts`),
 *     finds rows whose `nextRestartAt` has landed and actually drives the
 *     resume (`registry.triggerResume`).
 *
 * Persisting `nextRestartAt` on the descriptor (not just in memory) means a
 * daemon restart mid-backoff still resumes the schedule on the next sweep
 * tick — eager resume-on-boot only covers `endedReason:"daemon-restart"` and
 * would otherwise silently drop a `"crashed"` row's pending restart.
 *
 * NEVER restarts: a clean exit (`status:"exited"`), an operator `kill()`, an
 * `"idle-reaped"` or `"daemon-restart"` teardown, or a cost-budget kill (the
 * `overBudget` path in `sessions.ts`) — none of those set BOTH
 * `status:"error"` AND an absent/`"crashed"` `endedReason`, which is exactly
 * what `isEligibleForRestart` requires alongside an explicit
 * `restartPolicy`. A `killedMidTurn` row is handled structurally, not by a
 * special case here: `maybeResumeAgent` never replays the dropped prompt
 * regardless of why it's reviving a row (see `session-event-bus.ts`'s
 * `SessionResumedEvent` doc).
 */

import type { RestartPolicy, SessionDescriptor } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"

/** The slice of the sessions registry the restart-scheduler needs, split
 *  between the event handler (schedule/give-up) and the sweep (execute).
 *  Structural so both halves are pure, unit-testable functions decoupled
 *  from the full registry surface — same shape discipline as
 *  `CrashReaperRegistry`/`IdleReaperRegistry`. */
export interface RestartSchedulerRegistry {
  get(id: string): SessionDescriptor | undefined
  list(opts?: { includeArchived?: boolean }): readonly SessionDescriptor[]
  isResuming(id: string): boolean
  triggerResume(id: string): Promise<boolean>
  applyRestartSchedule(
    id: string,
    update: {
      nextRestartAt: string
      restartAttempts: number
      recentRestartAts: string[]
      lastRestartAt: string
    },
  ): boolean
  giveUpRestart(id: string, message: string): boolean
}

/**
 * Restart eligibility for one row's terminal state. True iff it carries an
 * opt-in `restartPolicy` AND died for a reason that policy opted into:
 *   - `endedReason === "crashed"` (the crash-detect sweep found the adapter
 *     process gone) when `"crashed"` is in `restartPolicy.on`;
 *   - `status === "error"` with NO `endedReason` at all (an unexpected turn
 *     error — `markCrashed` always stamps `endedReason`, so an absent one
 *     here can only be the turn-error path) when `"error"` is in
 *     `restartPolicy.on`.
 * Everything else — a clean exit, an operator kill, `"idle-reaped"`,
 * `"daemon-restart"`, an `overBudget` kill (`status:"killed"`, no reason) —
 * falls through to `false` without needing an explicit exclusion: none of
 * them produce the `(status, endedReason)` pair either branch requires.
 */
export function isEligibleForRestart(desc: SessionDescriptor): boolean {
  const policy = desc.restartPolicy
  if (!policy) return false
  if (desc.kind !== "agent-cli") return false
  if (desc.endedReason === "crashed") return policy.on.includes("crashed")
  if (desc.endedReason === undefined && desc.status === "error") {
    return policy.on.includes("error")
  }
  return false
}

/** Exponential backoff delay (ms) for the `attempt`-th restart (0-indexed —
 *  the FIRST restart is `attempt: 0`, using `baseDelayMs` unscaled), capped
 *  at `maxDelayMs`. */
export function computeBackoffMs(policy: RestartPolicy, attempt: number): number {
  return Math.min(policy.baseDelayMs * policy.factor ** attempt, policy.maxDelayMs)
}

/** Trim a rolling-window restart-timestamp list down to entries within
 *  `windowMs` of `nowMs` — anything older has aged out of the crash-loop
 *  cap's count. Unparseable entries are dropped (never counted against the
 *  cap; can't prove they're recent). */
function trimToWindow(recentRestartAts: string[] | undefined, windowMs: number, nowMs: number): string[] {
  if (!recentRestartAts) return []
  return recentRestartAts.filter(ts => {
    const parsed = Date.parse(ts)
    return Number.isFinite(parsed) && nowMs - parsed < windowMs
  })
}

export type RestartDecision =
  | {
      action: "schedule"
      nextRestartAt: string
      restartAttempts: number
      recentRestartAts: string[]
      lastRestartAt: string
    }
  | { action: "give-up"; message: string }

/**
 * Evaluate the backoff/crash-loop-cap policy for a row that already passed
 * `isEligibleForRestart` — pure over the descriptor + injected clock, so a
 * test pins a fake `nowMs` and asserts the curve/cap deterministically.
 *
 * Rolling-window crash-loop cap (distinct from `resumeAttempts`, which only
 * caps CONSECUTIVE FAILED revivals and would reset on a session that resumes
 * fine then re-crashes, looping forever): trims `recentRestartAts` to the
 * policy's `windowMs`, and if that many restarts have ALREADY fired within
 * the window (`>= maxRetries`), gives up rather than scheduling one more —
 * the (maxRetries+1)-th restart attempt within the window is the one that
 * trips it. Otherwise schedules the next restart at
 * `baseDelayMs * factor ** attempt` (capped at `maxDelayMs`) from now, and
 * appends `now` to the (already-trimmed) rolling window.
 */
export function evaluateRestartDecision(desc: SessionDescriptor, nowMs: number): RestartDecision {
  const policy = desc.restartPolicy
  if (!policy) {
    // Unreachable via the event-handler path (isEligibleForRestart already
    // required a policy) — guarded here so this function stays independently
    // callable/testable without that precondition silently producing NaNs.
    throw new Error("evaluateRestartDecision: descriptor has no restartPolicy")
  }
  const recent = trimToWindow(desc.recentRestartAts, policy.windowMs, nowMs)
  if (recent.length >= policy.maxRetries) {
    return {
      action: "give-up",
      message:
        `[crash-loop] gave up after ${recent.length} restarts in ${policy.windowMs}ms — ` +
        "leaving the session dead; a healthy turn after a manual resume resets the window",
    }
  }
  const attempt = desc.restartAttempts ?? 0
  const delayMs = computeBackoffMs(policy, attempt)
  const nowIso = new Date(nowMs).toISOString()
  return {
    action: "schedule",
    nextRestartAt: new Date(nowMs + delayMs).toISOString(),
    restartAttempts: attempt + 1,
    recentRestartAts: [...recent, nowIso],
    lastRestartAt: nowIso,
  }
}

/**
 * Wire the EVENT-driven half: subscribe to `session:exited` and, on an
 * eligible death, apply `evaluateRestartDecision`'s verdict through the
 * registry's mechanical primitives. Never touches the adapter — that's the
 * sweep's job (`runRestartSweepPass`). Returns a disposer (mirrors
 * `task-ledger.ts`'s `unsubscribeExited` pattern) — call it from the
 * gateway's `stop()`.
 */
export function createRestartScheduler(opts: {
  registry: RestartSchedulerRegistry
  sessionEvents: SessionEventBus
  /** Injected clock (ms since epoch). Defaults to `Date.now`. */
  now?: () => number
}): { dispose(): void } {
  const { registry, sessionEvents } = opts
  const unsubscribe = sessionEvents.on("session:exited", ev => {
    const desc = registry.get(ev.sessionId)
    if (!desc || !isEligibleForRestart(desc)) return
    const nowMs = opts.now ? opts.now() : Date.now()
    const decision = evaluateRestartDecision(desc, nowMs)
    if (decision.action === "give-up") {
      registry.giveUpRestart(desc.id, decision.message)
      return
    }
    registry.applyRestartSchedule(desc.id, {
      nextRestartAt: decision.nextRestartAt,
      restartAttempts: decision.restartAttempts,
      recentRestartAts: decision.recentRestartAts,
      lastRestartAt: decision.lastRestartAt,
    })
  })
  return { dispose: unsubscribe }
}

/** Tally of one restart-sweep tick, for the periodic log line + tests. */
export interface RestartSweepSummary {
  /** Whether the pass actually ran. False when `restartSweepIntervalMs` is
   *  non-positive/undefined (the knob is off) — same "disabled vs ran-and-
   *  found-nothing" distinction as `crash-reaper.ts`/`idle-reaper.ts`. */
  enabled: boolean
  /** Rows whose `nextRestartAt` had landed and weren't already resuming —
   *  the sweep's candidate set. */
  candidates: number
  /** Rows `registry.triggerResume` actually revived (`agentSession` bound
   *  afterward). A candidate that failed to resume is NOT counted here, but
   *  IS still a candidate — its `nextRestartAt` was consumed either way
   *  (`applyRestartSchedule`/a failed resume don't re-arm it; the row's next
   *  chance comes from its NEXT `session:exited`, per `markCrashed`/the
   *  turn-error path re-firing the event and re-entering the scheduler). */
  resumed: number
  /** The ids the sweep attempted (superset of `resumed`), for the sweep's
   *  summary log line. */
  ids: string[]
}

/**
 * Run one restart-sweep tick: find rows whose `nextRestartAt` has landed and
 * that aren't already mid-resume (a concurrent prompt, or an overlapping
 * tick — guarded via `registry.isResuming`), and drive
 * `registry.triggerResume` on each. Pure over the injected `now` (ms epoch),
 * so a test pins a fake clock and asserts deterministically — same shape as
 * `runIdleReapPass`. Async (unlike its PR-1 siblings) because
 * `triggerResume` awaits the adapter resume.
 */
export async function runRestartSweepPass(opts: {
  registry: RestartSchedulerRegistry
  /** Restart-sweep tick cadence (ms) — NOT a threshold read here; the value
   *  only gates whether the pass runs at all (mirrors `crashDetectIntervalMs`).
   *  Non-positive / undefined ⇒ the pass is DISABLED (off by default). */
  restartSweepIntervalMs: number | undefined
  /** Injected clock (ms since epoch). Defaults to `Date.now`. */
  now?: () => number
}): Promise<RestartSweepSummary> {
  const { registry } = opts
  const intervalMs = opts.restartSweepIntervalMs
  if (!intervalMs || intervalMs <= 0) {
    return { enabled: false, candidates: 0, resumed: 0, ids: [] }
  }
  const nowMs = opts.now ? opts.now() : Date.now()
  const all = registry.list({ includeArchived: true })
  const candidates = all.filter(d => {
    if (!d.nextRestartAt) return false
    const landed = Date.parse(d.nextRestartAt)
    if (!Number.isFinite(landed) || landed > nowMs) return false
    if (registry.isResuming(d.id)) return false
    return true
  })

  const summary: RestartSweepSummary = {
    enabled: true,
    candidates: candidates.length,
    resumed: 0,
    ids: [],
  }
  for (const d of candidates) {
    summary.ids.push(d.id)
    if (await registry.triggerResume(d.id)) {
      summary.resumed++
    }
  }
  return summary
}
