import { describe, expect, it } from "vitest"

import {
  initialTimelineState,
  reduceEvent,
  type TimelineEventRecord,
} from "../live-session-app.logic.js"

function reduceAll(records: TimelineEventRecord[]) {
  return records.reduce(reduceEvent, initialTimelineState())
}

describe("reduceEvent", () => {
  it("coalesces consecutive text-delta records for the same session into one row", () => {
    const state = reduceAll([
      { seq: 1, kind: "text-delta", sessionId: "s1", text: "Hel" },
      { seq: 2, kind: "text-delta", sessionId: "s1", text: "lo, " },
      { seq: 3, kind: "text-delta", sessionId: "s1", text: "world" },
    ])

    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ kind: "text", text: "Hello, world" })
  })

  it("starts a new text row when the session changes between deltas", () => {
    const state = reduceAll([
      { seq: 1, kind: "text-delta", sessionId: "s1", text: "a" },
      { seq: 2, kind: "text-delta", sessionId: "s2", text: "b" },
    ])

    expect(state.rows).toHaveLength(2)
    expect(state.rows[0]).toMatchObject({ sessionId: "s1", text: "a" })
    expect(state.rows[1]).toMatchObject({ sessionId: "s2", text: "b" })
  })

  it("pairs a tool-call with its later tool-result by toolCallId", () => {
    const state = reduceAll([
      {
        seq: 1,
        kind: "tool-call",
        sessionId: "s1",
        toolCallId: "call-1",
        toolName: "bash",
        arguments: { cmd: "ls" },
      },
      {
        seq: 2,
        kind: "tool-result",
        sessionId: "s1",
        toolCallId: "call-1",
        result: { stdout: "ok" },
        isError: false,
      },
    ])

    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({
      kind: "tool-call",
      toolCallId: "call-1",
      toolName: "bash",
      arguments: { cmd: "ls" },
      status: "ok",
      result: { stdout: "ok" },
    })
  })

  it("flags a tool-result with isError:true as an error status", () => {
    const state = reduceAll([
      {
        seq: 1,
        kind: "tool-call",
        sessionId: "s1",
        toolCallId: "call-2",
        toolName: "read_file",
        arguments: { path: "/missing" },
      },
      {
        seq: 2,
        kind: "tool-result",
        sessionId: "s1",
        toolCallId: "call-2",
        result: "ENOENT",
        isError: true,
      },
    ])

    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ status: "error", result: "ENOENT" })
  })

  it("appends a turn-end row with its reason", () => {
    const state = reduceAll([{ seq: 1, kind: "turn-end", sessionId: "s1", reason: "stop" }])

    expect(state.rows).toEqual([
      { kind: "turn-end", id: "turn-end-1", seq: 1, ts: undefined, sessionId: "s1", reason: "stop" },
    ])
  })

  it("appends a usage_update row with token/cost fields", () => {
    const state = reduceAll([
      {
        seq: 1,
        kind: "usage_update",
        sessionId: "s1",
        size: 1000,
        used: 200,
        cost: 0.05,
        tokensIn: 150,
        tokensOut: 50,
      },
    ])

    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({
      kind: "usage_update",
      size: 1000,
      used: 200,
      cost: 0.05,
      tokensIn: 150,
      tokensOut: 50,
    })
  })

  it("ignores unknown kinds and returns the same state reference", () => {
    const before = initialTimelineState()
    const after = reduceEvent(before, { seq: 1, kind: "some-future-kind", sessionId: "s1" })

    expect(after).toBe(before)
    expect(after.rows).toEqual([])
  })

  it("reduces a full mixed sequence deterministically", () => {
    const state = reduceAll([
      { seq: 1, kind: "text-delta", sessionId: "s1", text: "thinking" },
      { seq: 2, kind: "text-delta", sessionId: "s1", text: "..." },
      {
        seq: 3,
        kind: "tool-call",
        sessionId: "s1",
        toolCallId: "call-1",
        toolName: "bash",
        arguments: { cmd: "pwd" },
      },
      { seq: 4, kind: "notice", sessionId: "s1", text: "ignored" },
      { seq: 5, kind: "tool-result", sessionId: "s1", toolCallId: "call-1", result: "/tmp", isError: false },
      { seq: 6, kind: "turn-end", sessionId: "s1", reason: "done" },
      { seq: 7, kind: "usage_update", sessionId: "s1", size: 500, used: 100 },
    ])

    expect(state.rows.map(r => r.kind)).toEqual(["text", "tool-call", "turn-end", "usage_update"])
    expect(state.rows[0]).toMatchObject({ text: "thinking..." })
    expect(state.rows[1]).toMatchObject({ status: "ok", result: "/tmp" })
  })
})
