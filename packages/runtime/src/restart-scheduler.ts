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
 *
 * SANDBOX-GONE branch (`restartPolicy.on` listing `"sandbox-gone"`): a box
 * session whose BOX is gone cannot be revived in place at all, so the
 * scheduler classifies the death (`sandbox-gone.ts`) and schedules a FRESH-
 * BOX move instead — executed by the sweep through
 * `registry.triggerSandboxGoneRestart` (the same `restartAgentSession` path
 * `session_restart` takes), with the same backoff and crash-loop cap.
 */

import type { RestartPolicy, SessionDescriptor } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"
import { hasSandboxGoneEvidence, isBoxSession } from "./sandbox-gone.js"

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
  /** Execute a `nextRestartFreshBox` schedule — the fresh-box move a
   *  `"sandbox-gone"` policy fires (never an in-place revival). See
   *  `SessionsRegistry.triggerSandboxGoneRestart`'s doc. */
  triggerSandboxGoneRestart(id: string): Promise<boolean>
  applyRestartSchedule(
    id: string,
    update: {
      nextRestartAt: string
      restartAttempts: number
      recentRestartAts: string[]
      lastRestartAt: string
      freshBox?: boolean
    },
  ): boolean
  giveUpRestart(id: string, message: string): boolean
}

/**
 * Restart eligibility for one row's terminal state. True iff it carries an
 * opt-in `restartPolicy` AND died for a reason that policy opted into:
 *   - `endedReason === "sandbox_gone"` (the boot reattach pass — or any other
 *     provider-confirmed path — found the box itself gone) when
 *     `"sandbox-gone"` is in `restartPolicy.on`; revived by moving to a FRESH
 *     box, never in place;
 *   - `endedReason === "crashed"` (the crash-detect sweep found the adapter
 *     process gone) when `"crashed"` is in `restartPolicy.on`;
 *   - `status === "error"` with NO `endedReason` at all (an unexpected turn
 *     error — `markCrashed` always stamps `endedReason`, so an absent one
 *     here can only be the turn-error path) when `"error"` is in
 *     `restartPolicy.on`.
 * A SUSPECTED (not yet confirmed) box death — a box session that died as a
 * bare crash/turn error while its policy also lists `"sandbox-gone"` — is
 * classified by the event handler's async box-gone probe
 * (`createRestartScheduler`'s `isSandboxBoxGone`) BEFORE this gate decides;
 * once the probe says the box is gone the row is scheduled as a fresh-box
 * move and the in-place gates below never apply. Everything else — a clean
 * exit, an operator kill, `"idle-reaped"`, `"daemon-restart"`, an
 * `overBudget` kill (`status:"killed"`, no reason) — falls through to `false`
 * without needing an explicit exclusion: none of them produce the `(status,
 * endedReason)` pair either branch requires.
 */
export function isEligibleForRestart(desc: SessionDescriptor): boolean {
  const policy = desc.restartPolicy
  if (!policy) return false
  if (desc.kind !== "agent-cli") return false
  if (desc.endedReason === "sandbox_gone") return policy.on.includes("sandbox-gone")
  if (desc.endedReason === "crashed") return policy.on.includes("crashed")
  if (desc.endedReason === undefined && desc.status === "error") {
    return policy.on.includes("error")
  }
  return false
}

/**
 * The death SHAPE a restart may consider, independent of WHICH `on` entry
 * authorizes it: exactly the three shapes `isEligibleForRestart` recognizes,
 * with the policy lookup factored out. The sandbox-gone branch consults this
 * instead of `isEligibleForRestart`, because a `"sandbox-gone"` policy opt-in
 * authorizes a DIFFERENT entry than the one the shape names — while still
 * refusing to restart a death the policy was never meant to touch. A clean
 * exit, an operator `kill()`, `"idle-reaped"`, `"daemon-restart"` and a
 * cost-budget kill all fall to false, so a box session that died one of those
 * ways is NEVER routed to the fresh-box move no matter what the box probe
 * would have said.
 */
export function hasRestartableDeathShape(desc: SessionDescriptor): boolean {
  if (desc.endedReason === "sandbox_gone") return true
  if (desc.endedReason === "crashed") return true
  return desc.endedReason === undefined && desc.status === "error"
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
 *
 * `"sandbox-gone"` branch: a box session whose policy lists it is classified
 * by the injected `isSandboxBoxGone` probe (defaults to the synchronous
 * descriptor evidence — `endedReason:"sandbox_gone"` or a recorded box-gone
 * death message) BEFORE the in-place gates: a gone box schedules a FRESH-BOX
 * move (`freshBox: true`, executed by the sweep via
 * `registry.triggerSandboxGoneRestart`) instead of an in-place revival, which
 * is structurally doomed there. The probe is consulted first because a box
 * that died at its lifetime cap typically surfaces as a bare turn error /
 * crash — matching the classic `"error"`/`"crashed"` gates — and reviving in
 * place would fail against a box that no longer exists. A non-box session's
 * schedule stays fully synchronous (the probe branch is never entered), so
 * the classic paths keep their event-time determinism.
 */
export function createRestartScheduler(opts: {
  registry: RestartSchedulerRegistry
  sessionEvents: SessionEventBus
  /** Is this DEAD box session's box gone? Consulted only for a box session
   *  whose policy lists `"sandbox-gone"`. Defaults to the synchronous
   *  descriptor evidence (`hasSandboxGoneEvidence`); the gateway wires the
   *  ledger + one-shot provider probe (`sandbox-gone.ts`'s
   *  `isSandboxBoxGone`). */
  isSandboxBoxGone?: (desc: SessionDescriptor) => Promise<boolean> | boolean
  /** Injected clock (ms since epoch). Defaults to `Date.now`. */
  now?: () => number
}): { dispose(): void } {
  const { registry, sessionEvents } = opts
  const applyDecision = (desc: SessionDescriptor, freshBox: boolean): void => {
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
      ...(freshBox ? { freshBox: true } : {}),
    })
  }
  const unsubscribe = sessionEvents.on("session:exited", ev => {
    // Synchronous fast path (no box-gone policy involvement): evaluated
    // inline during `emit`, exactly like before, so a classic
    // crashed/error schedule stamps before this handler returns.
    const desc = registry.get(ev.sessionId)
    if (!desc || desc.kind !== "agent-cli" || !desc.restartPolicy) return
    const policy = desc.restartPolicy
    if (
      policy.on.includes("sandbox-gone") &&
      isBoxSession(desc) &&
      // Shape gate BEFORE the probe: a clean exit, an operator kill, an
      // idle-reap or a cost-budget kill is never restartable, so the box
      // probe must not be the thing that decides otherwise.
      hasRestartableDeathShape(desc)
    ) {
      // Async classification — microtask-deferred, never blocks the emit.
      void (async () => {
        const gone = await (opts.isSandboxBoxGone ?? hasSandboxGoneEvidence)(desc)
        if (gone) {
          applyDecision(desc, true)
          return
        }
        // The box is alive (or undeterminable): the classic gates apply.
        if (isEligibleForRestart(desc)) applyDecision(desc, false)
      })()
      return
    }
    if (!isEligibleForRestart(desc)) return
    applyDecision(desc, false)
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
    // A `nextRestartFreshBox` schedule is a "box-gone" move: dispatch it to
    // the registry's fresh-box hook, never the in-place resume.
    const ok =
      d.nextRestartFreshBox === true
        ? await registry.triggerSandboxGoneRestart(d.id)
        : await registry.triggerResume(d.id)
    if (ok) {
      summary.resumed++
    }
  }
  return summary
}
