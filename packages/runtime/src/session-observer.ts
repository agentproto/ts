/**
 * A per-session observer — the pluggable seam behind the runtime's transcript
 * tap. `sessions.ts` drives one observer per turn (prompt in, each stream event,
 * the turn-boundary usage snapshot, close). The transcript writer is the first
 * and, today, only member; additional observers (e.g. a Langfuse session tracer)
 * attach without touching the turn loop.
 *
 * The method set is exactly the subset of `TranscriptWriter` the session loop
 * calls, so `TranscriptWriter` IS a `SessionObserver` (see transcript-writer.ts).
 */

import type { AgentStreamEvent } from "./sessions.js"
import type { SessionUsage } from "./usage.js"

export interface SessionObserver {
  /** Record the outgoing message that opens a new turn. */
  recordPrompt(sessionId: string, message: unknown): void
  /** Record one structured stream event (text-delta, tool-call, usage_update, …). */
  recordEvent(sessionId: string, evt: AgentStreamEvent): void
  /** Record the durable turn-boundary / exit usage snapshot. */
  recordUsageSnapshot(sessionId: string, usage: SessionUsage): void
  /** Flush and close this session's stream. Idempotent, fire-and-forget. */
  close(sessionId: string): Promise<void>
  /** Close every open session stream (synchronous shutdown path). */
  closeAll(): Promise<void>
}

/**
 * Fan a `SessionObserver` out over many. Each `record*` call is forwarded to
 * every member in order; `close`/`closeAll` await all members.
 *
 * Every individual member call is isolated in try/catch so one throwing observer
 * can neither break its siblings nor propagate into the turn loop — the
 * transcript writer is effectively infallible today, but a future network-backed
 * observer (a Langfuse sink) must never be able to throw a turn. Failures are
 * swallowed here (no logging dependency at this layer); observers that need
 * visibility into their own failures own that internally.
 */
export function composeSessionObservers(
  observers: readonly SessionObserver[],
): SessionObserver {
  const forEachSafe = (fn: (o: SessionObserver) => void): void => {
    for (const o of observers) {
      try {
        fn(o)
      } catch {
        // isolate: a failing observer must not break siblings or the turn loop
      }
    }
  }

  const closeSafe = async (fn: (o: SessionObserver) => Promise<void>): Promise<void> => {
    await Promise.all(
      observers.map(async (o) => {
        try {
          await fn(o)
        } catch {
          // isolate close failures too — shutdown must not hang or throw
        }
      }),
    )
  }

  return {
    recordPrompt(sessionId, message) {
      forEachSafe((o) => o.recordPrompt(sessionId, message))
    },
    recordEvent(sessionId, evt) {
      forEachSafe((o) => o.recordEvent(sessionId, evt))
    },
    recordUsageSnapshot(sessionId, usage) {
      forEachSafe((o) => o.recordUsageSnapshot(sessionId, usage))
    },
    async close(sessionId) {
      await closeSafe((o) => o.close(sessionId))
    },
    async closeAll() {
      await closeSafe((o) => o.closeAll())
    },
  }
}

/**
 * Wrap a `SessionObserver` so `record*` calls only reach `inner` for session
 * ids `shouldObserve` accepts — e.g. an opt-in Langfuse tracer that should
 * only see sessions that asked to be traced. `close`/`closeAll` always
 * forward: cleanup is idempotent and must run regardless of opt-in state so
 * the inner observer never leaks a per-session resource.
 *
 * Each forwarded call is isolated in try/catch, same as
 * `composeSessionObservers` — a throwing inner observer must not break the
 * turn loop.
 */
export function filterSessionObserver(
  inner: SessionObserver,
  shouldObserve: (sessionId: string) => boolean,
): SessionObserver {
  return {
    recordPrompt(sessionId, message) {
      if (!shouldObserve(sessionId)) return
      try {
        inner.recordPrompt(sessionId, message)
      } catch {
        // isolate: a failing observer must not break the turn loop
      }
    },
    recordEvent(sessionId, evt) {
      if (!shouldObserve(sessionId)) return
      try {
        inner.recordEvent(sessionId, evt)
      } catch {
        // isolate: a failing observer must not break the turn loop
      }
    },
    recordUsageSnapshot(sessionId, usage) {
      if (!shouldObserve(sessionId)) return
      try {
        inner.recordUsageSnapshot(sessionId, usage)
      } catch {
        // isolate: a failing observer must not break the turn loop
      }
    },
    async close(sessionId) {
      try {
        await inner.close(sessionId)
      } catch {
        // isolate close failures too — shutdown must not hang or throw
      }
    },
    async closeAll() {
      try {
        await inner.closeAll()
      } catch {
        // isolate close failures too — shutdown must not hang or throw
      }
    },
  }
}
