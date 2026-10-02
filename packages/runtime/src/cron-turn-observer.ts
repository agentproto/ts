/**
 * Production `CronTurnObserver`: follows a cron-spawned session until its
 * first turn ends, then classifies the real outcome for the run ledger.
 *
 * Reuses the SAME blocking-wait core every other "wait for turn-end" caller
 * uses — `monitorSessionWait` (`orchestration-tools.ts`), the shared service
 * behind `session_monitor`, `GET /sessions/:id/wait`, and
 * `agentproto sessions wait --until turn-end`. No new polling loop.
 *
 * Classification (matches `cron-scheduler.ts`'s outcome vocabulary):
 *   - timedOut                        → "timeout"
 *   - exited before a completed turn  → "errored"
 *   - turn-end reason "error"         → "errored"
 *   - turn-end `empty` or 0 tokens    → "empty"
 *   - anything else                   → "produced"
 *
 * Output tokens are read off the descriptor (`tokensOut`) once the turn ends;
 * absent when the adapter doesn't report them (honest, not zero-filled).
 */

import { monitorSessionWait } from "./orchestration-tools.js"
import type { EventRing } from "./event-ring.js"
import type { SessionEventBus } from "./session-event-bus.js"
import type { SessionsRegistry } from "./sessions.js"
import type { CronTurnObservation, CronTurnObserver } from "./cron-scheduler.js"

export function createSessionTurnObserver(deps: {
  registry: SessionsRegistry
  sessionEvents: SessionEventBus
  eventRing: EventRing
}): CronTurnObserver {
  const { registry, sessionEvents, eventRing } = deps

  return async ({ sessionId, timeoutMs }): Promise<CronTurnObservation> => {
    const startedMs = Date.now()
    // `since: 0` lets the ring replay a turn-end that already fired before
    // this wait subscribed (a very fast first turn); the session id is brand
    // new, so the only matching events are its own.
    const result = await monitorSessionWait({
      registry,
      sessionEvents,
      eventRing,
      sessionIds: [sessionId],
      event: "any",
      timeoutMs,
      since: 0,
    })
    const durationMs = Date.now() - startedMs
    const desc = registry.get(sessionId)
    const tokensOut = typeof desc?.tokensOut === "number" ? desc.tokensOut : undefined
    const tokenField = tokensOut !== undefined ? { tokensOut } : {}

    if (result.timedOut) {
      return { outcome: "timeout", durationMs }
    }
    if (result.event === "exited") {
      return {
        outcome: "errored",
        ...tokenField,
        durationMs,
        error: `session ${result.status ?? "exited"} before completing a turn`,
      }
    }
    if (result.reason === "error") {
      return {
        outcome: "errored",
        ...tokenField,
        durationMs,
        reason: result.reason,
        ...(result.error ? { error: result.error } : {}),
      }
    }
    if (result.empty || tokensOut === 0) {
      return { outcome: "empty", ...tokenField, durationMs }
    }
    return { outcome: "produced", ...tokenField, durationMs }
  }
}
