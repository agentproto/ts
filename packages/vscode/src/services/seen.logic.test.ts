import { describe, expect, it } from "vitest"

import { isUnread, lastOutputMs, markSeen, pruneSeen, SEEN_MAX_ENTRIES } from "./seen.logic.js"
import type { SessionDescriptor } from "../client/types.js"

const T0 = Date.parse("2026-07-16T12:00:00.000Z")

function session(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "claude",
    pid: 1,
    status: "running",
    startedAt: new Date(T0).toISOString(),
    ...overrides,
  }
}

describe("lastOutputMs", () => {
  it("parses lastOutputAt", () => {
    expect(lastOutputMs(session({ lastOutputAt: new Date(T0).toISOString() }))).toBe(T0)
  })

  it("is undefined when absent or unparseable", () => {
    expect(lastOutputMs(session())).toBeUndefined()
    expect(lastOutputMs(session({ lastOutputAt: "not a date" }))).toBeUndefined()
  })
})

describe("isUnread", () => {
  it("is unread when output landed after the last look", () => {
    const s = session({ lastOutputAt: new Date(T0 + 5_000).toISOString() })
    expect(isUnread(s, T0)).toBe(true)
  })

  it("is read when the last look came after the output", () => {
    const s = session({ lastOutputAt: new Date(T0).toISOString() })
    expect(isUnread(s, T0 + 5_000)).toBe(false)
  })

  it("is read when the look lands exactly on the output", () => {
    // You were looking at the tab as it arrived — the panel marks seen on the
    // same store event that carried the output.
    const s = session({ lastOutputAt: new Date(T0).toISOString() })
    expect(isUnread(s, T0)).toBe(false)
  })

  it("is unread when never looked at", () => {
    const s = session({ lastOutputAt: new Date(T0).toISOString() })
    expect(isUnread(s, undefined)).toBe(true)
  })

  it("is read — not unread — when the session has never emitted anything", () => {
    // Nothing to read. A freshly spawned session must not shout for attention
    // it hasn't earned.
    expect(isUnread(session(), undefined)).toBe(false)
  })

  it("ignores an unparseable timestamp rather than crying wolf", () => {
    expect(isUnread(session({ lastOutputAt: "garbage" }), undefined)).toBe(false)
  })
})

describe("markSeen", () => {
  it("records a receipt", () => {
    expect(markSeen({}, "s1", T0)).toEqual({ s1: T0 })
  })

  it("advances an existing receipt", () => {
    expect(markSeen({ s1: T0 }, "s1", T0 + 1_000)).toEqual({ s1: T0 + 1_000 })
  })

  it("never moves a receipt backwards", () => {
    // Replaying an older mark must not resurrect output already read.
    const before = { s1: T0 + 1_000 }
    expect(markSeen(before, "s1", T0)).toBe(before)
  })

  it("returns the same object when nothing changes, so callers can skip a repaint", () => {
    const before = { s1: T0 }
    expect(markSeen(before, "s1", T0)).toBe(before)
  })

  it("leaves other sessions alone", () => {
    expect(markSeen({ s1: T0 }, "s2", T0)).toEqual({ s1: T0, s2: T0 })
  })
})

describe("pruneSeen", () => {
  it("keeps everything under the cap", () => {
    const map = { a: 1, b: 2 }
    expect(pruneSeen(map, 10)).toBe(map)
  })

  it("evicts the least-recently-read past the cap", () => {
    const map = { old: 1, mid: 2, fresh: 3 }
    expect(pruneSeen(map, 2)).toEqual({ fresh: 3, mid: 2 })
  })

  it("bounds the map as receipts accumulate", () => {
    let map: Record<string, number> = {}
    for (let i = 0; i < SEEN_MAX_ENTRIES + 50; i++) map = markSeen(map, `s${i}`, T0 + i)
    expect(Object.keys(map)).toHaveLength(SEEN_MAX_ENTRIES)
    // The most recent survive; the oldest are gone.
    expect(map[`s${SEEN_MAX_ENTRIES + 49}`]).toBeDefined()
    expect(map.s0).toBeUndefined()
  })
})
