import { describe, expect, it } from "vitest"

import type { SessionActivity } from "../views/sessionsTree.logic.js"
import {
  detectWatchTransitions,
  notificationKindFor,
  type WatchActivityMap,
} from "./watchedSessions.logic.js"

describe("notificationKindFor", () => {
  it("warns on the states a parked session would otherwise die in silently", () => {
    expect(notificationKindFor("needs-you")).toBe("warning")
    expect(notificationKindFor("stalled")).toBe("warning")
    expect(notificationKindFor("parked-bg")).toBe("warning")
  })
  it("informs on terminal outcomes", () => {
    expect(notificationKindFor("done")).toBe("info")
    expect(notificationKindFor("failed")).toBe("info")
  })
  it("stays silent on ordinary working/idle churn", () => {
    expect(notificationKindFor("working")).toBeUndefined()
    expect(notificationKindFor("idle")).toBeUndefined()
    expect(notificationKindFor("stopped")).toBeUndefined()
  })
})

describe("detectWatchTransitions", () => {
  it("fires when a watched session transitions INTO a notifiable state", () => {
    const previous: WatchActivityMap = { s1: "working" }
    const current: Record<string, SessionActivity> = { s1: "needs-you" }
    expect(detectWatchTransitions(previous, current)).toEqual([
      { sessionId: "s1", activity: "needs-you", kind: "warning" },
    ])
  })

  it("fires for parked-bg and stalled too", () => {
    const previous: WatchActivityMap = { s1: "working", s2: "working" }
    const current: Record<string, SessionActivity> = { s1: "parked-bg", s2: "stalled" }
    expect(detectWatchTransitions(previous, current)).toEqual([
      { sessionId: "s1", activity: "parked-bg", kind: "warning" },
      { sessionId: "s2", activity: "stalled", kind: "warning" },
    ])
  })

  it("fires info for done and failed", () => {
    const previous: WatchActivityMap = { s1: "working", s2: "working" }
    const current: Record<string, SessionActivity> = { s1: "done", s2: "failed" }
    expect(detectWatchTransitions(previous, current)).toEqual([
      { sessionId: "s1", activity: "done", kind: "info" },
      { sessionId: "s2", activity: "failed", kind: "info" },
    ])
  })

  it("does NOT re-fire while the session stays in the same state (debounce)", () => {
    const previous: WatchActivityMap = { s1: "needs-you" }
    const current: Record<string, SessionActivity> = { s1: "needs-you" }
    expect(detectWatchTransitions(previous, current)).toEqual([])
  })

  it("does not fire on non-notifiable transitions", () => {
    const previous: WatchActivityMap = { s1: "idle" }
    const current: Record<string, SessionActivity> = { s1: "working" }
    expect(detectWatchTransitions(previous, current)).toEqual([])
  })

  it("a first-sighting session transitions only when its state is notifiable", () => {
    // No baseline (session just appeared in the store) — a parked-bg session
    // still earns the toast; an idle one does not.
    expect(detectWatchTransitions({}, { s1: "parked-bg" })).toEqual([
      { sessionId: "s1", activity: "parked-bg", kind: "warning" },
    ])
    expect(detectWatchTransitions({}, { s1: "idle" })).toEqual([])
  })

  it("a session that left the notifiable state can re-enter it and fire again", () => {
    // s1 went needs-you → working → needs-you: the second arrival IS a new
    // transition (the state genuinely changed in between).
    const transitions = detectWatchTransitions({ s1: "working" }, { s1: "needs-you" })
    expect(transitions).toEqual([{ sessionId: "s1", activity: "needs-you", kind: "warning" }])
  })
})
