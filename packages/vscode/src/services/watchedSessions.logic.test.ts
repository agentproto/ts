import { describe, expect, it } from "vitest"

import type { SessionActivity } from "../views/sessionsTree.logic.js"
import {
  detectWatchTransitions,
  notificationKindFor,
  type WatchActivityMap,
} from "./watchedSessions.logic.js"

describe("notificationKindFor — watched tier", () => {
  it("warns on the states a parked watched session would otherwise die in silently", () => {
    expect(notificationKindFor("needs-you", true)).toBe("warning")
    expect(notificationKindFor("stalled", true)).toBe("warning")
    expect(notificationKindFor("parked-bg", true)).toBe("warning")
  })
  it("informs watched sessions on terminal outcomes", () => {
    expect(notificationKindFor("done", true)).toBe("info")
    expect(notificationKindFor("failed", true)).toBe("info")
  })
  it("stays silent on ordinary working/idle churn", () => {
    expect(notificationKindFor("working", true)).toBeUndefined()
    expect(notificationKindFor("idle", true)).toBeUndefined()
    expect(notificationKindFor("stopped", true)).toBeUndefined()
  })
})

describe("notificationKindFor — auto-toast tier (unwatched)", () => {
  it("always warns on needs-you — the one state that blocks on the human", () => {
    expect(notificationKindFor("needs-you", false)).toBe("warning")
  })
  it("is silent on everything else so auto-spawned sessions stay quiet", () => {
    expect(notificationKindFor("stalled", false)).toBeUndefined()
    expect(notificationKindFor("parked-bg", false)).toBeUndefined()
    expect(notificationKindFor("done", false)).toBeUndefined()
    expect(notificationKindFor("failed", false)).toBeUndefined()
    expect(notificationKindFor("working", false)).toBeUndefined()
    expect(notificationKindFor("idle", false)).toBeUndefined()
    expect(notificationKindFor("stopped", false)).toBeUndefined()
  })
})

describe("detectWatchTransitions", () => {
  it("fires when a watched session transitions INTO a notifiable state", () => {
    const previous: WatchActivityMap = { s1: "working" }
    const current: Record<string, SessionActivity> = { s1: "needs-you" }
    expect(detectWatchTransitions(previous, current, new Set(["s1"]))).toEqual([
      { sessionId: "s1", activity: "needs-you", kind: "warning" },
    ])
  })

  it("fires for parked-bg and stalled too", () => {
    const previous: WatchActivityMap = { s1: "working", s2: "working" }
    const current: Record<string, SessionActivity> = { s1: "parked-bg", s2: "stalled" }
    expect(detectWatchTransitions(previous, current, new Set(["s1", "s2"]))).toEqual([
      { sessionId: "s1", activity: "parked-bg", kind: "warning" },
      { sessionId: "s2", activity: "stalled", kind: "warning" },
    ])
  })

  it("fires info for done and failed", () => {
    const previous: WatchActivityMap = { s1: "working", s2: "working" }
    const current: Record<string, SessionActivity> = { s1: "done", s2: "failed" }
    expect(detectWatchTransitions(previous, current, new Set(["s1", "s2"]))).toEqual([
      { sessionId: "s1", activity: "done", kind: "info" },
      { sessionId: "s2", activity: "failed", kind: "info" },
    ])
  })

  it("does NOT re-fire while the session stays in the same state (debounce)", () => {
    const previous: WatchActivityMap = { s1: "needs-you" }
    const current: Record<string, SessionActivity> = { s1: "needs-you" }
    expect(detectWatchTransitions(previous, current, new Set(["s1"]))).toEqual([])
  })

  it("does not fire on non-notifiable transitions", () => {
    const previous: WatchActivityMap = { s1: "idle" }
    const current: Record<string, SessionActivity> = { s1: "working" }
    expect(detectWatchTransitions(previous, current, new Set(["s1"]))).toEqual([])
  })

  it("a first-sighting session transitions only when its state is notifiable", () => {
    // No baseline (session just appeared in the store) — a parked-bg session
    // still earns the toast; an idle one does not.
    expect(detectWatchTransitions({}, { s1: "parked-bg" }, new Set(["s1"]))).toEqual([
      { sessionId: "s1", activity: "parked-bg", kind: "warning" },
    ])
    expect(detectWatchTransitions({}, { s1: "idle" }, new Set(["s1"]))).toEqual([])
  })

  it("a session that left the notifiable state can re-enter it and fire again", () => {
    // s1 went needs-you → working → needs-you: the second arrival IS a new
    // transition (the state genuinely changed in between).
    const transitions = detectWatchTransitions({ s1: "working" }, { s1: "needs-you" }, new Set(["s1"]))
    expect(transitions).toEqual([{ sessionId: "s1", activity: "needs-you", kind: "warning" }])
  })
})

describe("detectWatchTransitions — auto-toast tier (unwatched)", () => {
  it("fires the unconditional warning when an unwatched session lands in needs-you", () => {
    const previous: WatchActivityMap = { s1: "working" }
    const current: Record<string, SessionActivity> = { s1: "needs-you" }
    expect(detectWatchTransitions(previous, current, new Set())).toEqual([
      { sessionId: "s1", activity: "needs-you", kind: "warning" },
    ])
  })

  it("fires even for a first-sighting unwatched session already stuck in needs-you", () => {
    expect(detectWatchTransitions({}, { s1: "needs-you" }, new Set())).toEqual([
      { sessionId: "s1", activity: "needs-you", kind: "warning" },
    ])
  })

  it("stays silent when an unwatched session stalls, parks, fails, or finishes", () => {
    const previousSessionStates: WatchActivityMap = { s1: "working", s2: "working" }
    const currentSessionStates: Record<string, SessionActivity> = {
      s1: "stalled",
      s2: "parked-bg",
    }
    expect(detectWatchTransitions(previousSessionStates, currentSessionStates, new Set())).toEqual([])
    expect(detectWatchTransitions({ s1: "working" }, { s1: "failed" }, new Set())).toEqual([])
    expect(detectWatchTransitions({ s1: "working" }, { s1: "done" }, new Set())).toEqual([])
  })

  it("debounces the auto-toast like any other tier", () => {
    expect(detectWatchTransitions({ s1: "needs-you" }, { s1: "needs-you" }, new Set())).toEqual([])
  })

  it("mixes tiers in one pass — watched earns its set, unwatched only needs-you", () => {
    const previous: WatchActivityMap = { watched: "working", unwatched: "working" }
    const current: Record<string, SessionActivity> = {
      watched: "stalled",
      unwatched: "needs-you",
    }
    expect(detectWatchTransitions(previous, current, new Set(["watched"]))).toEqual([
      { sessionId: "watched", activity: "stalled", kind: "warning" },
      { sessionId: "unwatched", activity: "needs-you", kind: "warning" },
    ])
  })
})
