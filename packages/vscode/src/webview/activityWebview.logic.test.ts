import { describe, expect, it } from "vitest"

import type { ActivityRecord, SessionSummary } from "../client/types.js"
import {
  buildActivityWebviewModel,
  relativeAgeFrom,
  TERMINAL_ACTIVITY_CAP,
  waitingOnText,
  type ActivityRow,
} from "./activityWebview.logic.js"

const NOW = Date.parse("2026-09-12T12:00:00Z")

function rec(overrides: Partial<ActivityRecord> & { id: string }): ActivityRecord {
  return {
    kind: "turn",
    sourceRef: "src",
    source: "session",
    title: `Activity ${overrides.id}`,
    startedAt: "2026-09-12T11:50:00Z",
    ...overrides,
  } as ActivityRecord
}

function sess(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    kind: "agent-cli",
    status: "idle",
    startedAt: "2026-09-12T10:00:00Z",
    ...overrides,
  } as unknown as SessionSummary
}

describe("waitingOnText", () => {
  it("produces text for all six kinds", () => {
    expect(waitingOnText({ kind: "session-turn", refs: ["a"] })).toBe("waiting on a session turn")
    expect(waitingOnText({ kind: "human-ack", refs: ["p"] })).toBe("waiting on a human ack")
    expect(waitingOnText({ kind: "cap-slot", refs: ["p"] })).toMatch(/waiting on .*/)
    expect(waitingOnText({ kind: "stage-barrier", refs: [] })).toMatch(/waiting on .*/)
    expect(waitingOnText({ kind: "forge", refs: ["url"] })).toMatch(/waiting on .*/)
    expect(waitingOnText({ kind: "timer", refs: [] })).toMatch(/waiting on .*/)
  })

  it("counts refs for session-turn fan-in", () => {
    expect(waitingOnText({ kind: "session-turn", refs: ["a", "b"] })).toBe("waiting on 2 session turns")
    expect(waitingOnText({ kind: "session-turn", refs: [] })).toBe("waiting on a session turn")
  })

  it("detail wins over the derived sentence", () => {
    expect(waitingOnText({ kind: "human-ack", refs: ["p"], detail: "green gate parked on policy_ack" })).toBe(
      "green gate parked on policy_ack",
    )
  })

  it("never throws on a malformed payload", () => {
    expect(waitingOnText(undefined)).not.toBe("")
    expect(waitingOnText(null)).not.toBe("")
    expect(waitingOnText(42)).not.toBe("")
    expect(waitingOnText({ refs: "not-an-array" })).not.toBe("")
    expect(waitingOnText({ kind: "mystery", refs: [] })).not.toBe("")
  })
})

describe("relativeAgeFrom", () => {
  it("formats relative ages and degrades on unparseable input", () => {
    expect(relativeAgeFrom("2026-09-12T11:59:30Z", NOW)).toBe("just now")
    expect(relativeAgeFrom("2026-09-12T11:52:00Z", NOW)).toBe("8m ago")
    expect(relativeAgeFrom("2026-09-12T06:00:00Z", NOW)).toBe("6h ago")
    expect(relativeAgeFrom("2026-09-06T00:00:00Z", NOW)).toBe("6d ago")
    expect(relativeAgeFrom("not-a-date", NOW)).toBe("")
    expect(relativeAgeFrom(undefined, NOW)).toBe("")
  })
})

describe("buildActivityWebviewModel", () => {
  it("yields an empty model, not a throw, on empty or malformed input", () => {
    expect(buildActivityWebviewModel({ activities: [], sessions: [], now: NOW })).toEqual({
      groups: [],
      shownCount: 0,
    })
    const model = buildActivityWebviewModel({ activities: undefined, sessions: undefined, now: NOW })
    expect(model.groups).toEqual([])
    const malformed = buildActivityWebviewModel({
      activities: [null, 42, rec({ id: "ok", sessionId: "s1" })] as unknown as ActivityRecord[],
      sessions: [null, sess({ id: "s1" })] as unknown as SessionSummary[],
      now: NOW,
    })
    expect(malformed.groups.map(g => g.key)).toEqual(["s1"])
  })

  it("groups per subject session, labelled with the display name, active before pending before terminal", () => {
    const model = buildActivityWebviewModel({
      activities: [
        rec({ id: "t-done", sessionId: "s1", state: "done", startedAt: "2026-09-12T11:00:00Z" }),
        rec({ id: "t-pend", sessionId: "s1", state: "pending", waitingOn: { kind: "human-ack", refs: ["s1"] }, startedAt: "2026-09-12T11:40:00Z" }),
        rec({ id: "t-act", sessionId: "s1", state: "active", startedAt: "2026-09-12T11:55:00Z" }),
        rec({ id: "p1", sessionId: "s2", state: "active", startedAt: "2026-09-12T11:56:00Z" }),
      ],
      sessions: [sess({ id: "s1", label: "My agent" }), sess({ id: "s2" })],
      now: NOW,
    })
    expect(model.groups.map(g => g.label)).toEqual(["My agent", "agent-cli · s2"])
    expect(model.groups[0]!.rows.map(r => r.state)).toEqual(["active", "pending", "done"])
    const pending = model.groups[0]!.rows[1]!
    expect(pending.waitingOn).toBe("waiting on a human ack")
    expect(pending.age).toBe("20m ago")
  })

  it("puts a sessionIds fan-in record under its FIRST session", () => {
    const model = buildActivityWebviewModel({
      activities: [rec({ id: "p1", sessionId: "a", sessionIds: ["a", "b", "c"], state: "pending", waitingOn: { kind: "session-turn", refs: ["b", "c"] } })],
      sessions: [sess({ id: "a", label: "Root" }), sess({ id: "b" }), sess({ id: "c" })],
      now: NOW,
    })
    expect(model.groups.map(g => g.key)).toEqual(["a"])
    expect(model.groups[0]!.rows[0]!.waitingOn).toBe("waiting on 2 session turns")
  })

  it("renders the Terminals and Commands shell groups, newest first", () => {
    const model = buildActivityWebviewModel({
      activities: [],
      sessions: [
        sess({ id: "t-old", kind: "terminal", status: "exited", exitCode: 1, startedAt: "2026-09-12T08:00:00Z" }),
        sess({ id: "t-new", kind: "terminal", status: "running", startedAt: "2026-09-12T11:00:00Z" }),
        sess({ id: "cmd", kind: "command", status: "exited", exitCode: 0, startedAt: "2026-09-12T09:00:00Z" }),
        sess({ id: "cmd-child", kind: "command", status: "running", parentSessionId: "t-new" }),
      ],
      now: NOW,
    })
    expect(model.groups.map(g => g.key)).toEqual(["terminals", "commands"])
    expect(model.groups[0]!.rows.map(r => r.id)).toEqual(["t-new", "t-old"])
    expect(model.groups[1]!.rows.map(r => r.id)).toEqual(["cmd"])
  })

  it("caps terminal-state activities at the newest 20 across the whole model", () => {
    const activities: ActivityRecord[] = []
    for (let i = 0; i < 30; i++) {
      activities.push(rec({ id: `done-${i}`, sessionId: "s1", state: "done", startedAt: new Date(NOW - i * 60_000).toISOString() }))
    }
    const model = buildActivityWebviewModel({ activities, sessions: [sess({ id: "s1" })], now: NOW })
    const rows: ActivityRow[] = model.groups[0]!.rows
    expect(rows.filter(r => r.state === "done").length).toBe(TERMINAL_ACTIVITY_CAP)
    // The survivors are the NEWEST ones (0..19).
    expect(rows.some(r => r.id === "done-0")).toBe(true)
    expect(rows.some(r => r.id === "done-29")).toBe(false)
  })

  it("flags stale active rows without changing their state", () => {
    const model = buildActivityWebviewModel({
      activities: [
        rec({ id: "t1", sessionId: "s1", state: "active", staleSince: "2026-09-12T11:00:00Z" }),
        rec({ id: "t2", sessionId: "s1", state: "active" }),
      ],
      sessions: [sess({ id: "s1" })],
      now: NOW,
    })
    const byId = new Map(model.groups[0]!.rows.map(r => [r.id, r]))
    expect(byId.get("t1")!.stale).toBe(true)
    expect(byId.get("t1")!.state).toBe("active")
    expect(byId.get("t2")!.stale).toBe(false)
  })
})
