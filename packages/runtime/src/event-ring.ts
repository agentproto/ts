/**
 * Cursor-based ring buffer for session events. Bridges the in-process
 * SessionEventBus (push) to the session_events_poll MCP tool (pull).
 *
 * Capacity default: 1 000 events. Oldest entry dropped on overflow —
 * callers that lag beyond the cap see a gap in their cursor but never
 * a block. `since()` returns `nextCursor = totalEmitted` so a fresh
 * call with that value always starts just past the current tail.
 */

import type { SessionEvent, SessionEventBus, SessionEventType } from "./session-event-bus.js"

const DEFAULT_CAP = 1_000

export interface EventRingSnapshot {
  events: SessionEvent[]
  nextCursor: number
}

export interface EventRingQueryOpts {
  sessionIds?: string[]
  types?: SessionEventType[]
  /** Default 50. */
  limit?: number
}

export interface EventRing {
  /**
   * Return events whose ring-index >= `cursor`. Pass 0 to get all
   * retained events; pass the previously returned `nextCursor` for an
   * incremental read. The returned `nextCursor` is always equal to
   * `totalEmitted` — use it as the next `cursor` argument.
   *
   * Negative or below-base cursors are clamped to the oldest retained
   * event (no error, just a potential replay of a partial window).
   */
  since(cursor: number, opts?: EventRingQueryOpts): EventRingSnapshot
  /** Wire the ring to a SessionEventBus. Returns an unsubscribe fn. */
  wire(bus: SessionEventBus): () => void
}

export function createEventRing(cap = DEFAULT_CAP): EventRing {
  /** Circular store — oldest entry at index 0, newest at the tail. */
  const ring: SessionEvent[] = []
  /** Total events ever pushed. ring[0] has absolute index base = totalEmitted - ring.length. */
  let totalEmitted = 0

  return {
    since(cursor, opts = {}) {
      const limit = opts.limit ?? 50
      // Absolute index of ring[0]
      const base = totalEmitted - ring.length
      // Clamp cursor into the valid window
      const clampedStart = Math.max(0, cursor - base)
      let slice = ring.slice(clampedStart)

      if (opts.sessionIds && opts.sessionIds.length > 0) {
        const ids = new Set(opts.sessionIds)
        slice = slice.filter(e => ids.has(e.sessionId))
      }
      if (opts.types && opts.types.length > 0) {
        const types = new Set<string>(opts.types)
        slice = slice.filter(e => types.has(e.type))
      }

      return {
        events: slice.slice(0, limit),
        nextCursor: totalEmitted,
      }
    },

    wire(bus) {
      return bus.onAny(ev => {
        ring.push(ev)
        totalEmitted++
        if (ring.length > cap) ring.shift()
      })
    },
  }
}
