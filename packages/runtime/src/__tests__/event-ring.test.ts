import { describe, it, expect } from "vitest"
import { createEventRing } from "../event-ring.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionEvent } from "../session-event-bus.js"

function makeEvent(sessionId: string): SessionEvent {
  return { type: "session:turn-end", sessionId, awaitingInput: false, ts: "t" }
}

/** Narrow a SessionEvent to its sessionId (all events in this test are session:turn-end). */
function sid(ev: SessionEvent): string {
  return ((ev as unknown) as Record<string, unknown>)["sessionId"] as string
}

describe("EventRing", () => {
  it("returns empty when no events", () => {
    const ring = createEventRing()
    const { events, nextCursor } = ring.since(0)
    expect(events).toHaveLength(0)
    expect(nextCursor).toBe(0)
  })

  it("wire() populates ring from bus", () => {
    const bus = createSessionEventBus()
    const ring = createEventRing()
    ring.wire(bus)

    bus.emit(makeEvent("s1"))
    bus.emit(makeEvent("s2"))

    const { events, nextCursor } = ring.since(0)
    expect(events).toHaveLength(2)
    expect(nextCursor).toBe(2)
  })

  it("since(cursor) returns only new events", () => {
    const bus = createSessionEventBus()
    const ring = createEventRing()
    ring.wire(bus)

    bus.emit(makeEvent("s1"))
    const { nextCursor: c1 } = ring.since(0)

    bus.emit(makeEvent("s2"))
    const { events } = ring.since(c1)
    expect(events).toHaveLength(1)
    expect(sid(events[0]!)).toBe("s2")
  })

  it("respects limit", () => {
    const bus = createSessionEventBus()
    const ring = createEventRing()
    ring.wire(bus)

    for (let i = 0; i < 10; i++) bus.emit(makeEvent(`s${i}`))

    const { events } = ring.since(0, { limit: 3 })
    expect(events).toHaveLength(3)
  })

  it("filters by sessionIds", () => {
    const bus = createSessionEventBus()
    const ring = createEventRing()
    ring.wire(bus)

    bus.emit(makeEvent("alpha"))
    bus.emit(makeEvent("beta"))
    bus.emit(makeEvent("alpha"))

    const { events } = ring.since(0, { sessionIds: ["alpha"] })
    expect(events).toHaveLength(2)
    expect(events.every(e => sid(e) === "alpha")).toBe(true)
  })

  it("drops oldest on cap overflow", () => {
    const bus = createSessionEventBus()
    const ring = createEventRing(3)
    ring.wire(bus)

    bus.emit(makeEvent("a"))
    bus.emit(makeEvent("b"))
    bus.emit(makeEvent("c"))
    bus.emit(makeEvent("d"))

    const { events, nextCursor } = ring.since(0)
    expect(nextCursor).toBe(4)
    // only "b", "c", "d" retained (cap=3, "a" dropped)
    expect(events.map(e => sid(e))).toEqual(["b", "c", "d"])
  })

  it("unsubscribes cleanly from bus", () => {
    const bus = createSessionEventBus()
    const ring = createEventRing()
    const unsub = ring.wire(bus)

    bus.emit(makeEvent("before"))
    unsub()
    bus.emit(makeEvent("after"))

    const { events } = ring.since(0)
    expect(events).toHaveLength(1)
    expect(sid(events[0]!)).toBe("before")
  })
})
