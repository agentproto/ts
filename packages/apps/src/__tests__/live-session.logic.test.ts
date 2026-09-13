import { describe, expect, it } from "vitest"

import {
  extractToolResultSessionId,
  initialTimelineState,
  isNearBottom,
  groupAdjacentToolCalls,
  reduceEvent,
  SCROLL_STICK_THRESHOLD_PX,
  TOOL_CALL_GROUP_THRESHOLD,
  type TimelineEventRecord,
} from "../live-session/logic.js"

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

  it("rejoins an unterminated fragment split by an interleaved tool-call (mid-word debounce flush)", () => {
    // Real shape from a recorded session: the model paused >250ms mid-word
    // while emitting a tool_use block, so the transcript debounce flushed
    // "Bien re" flagged `partial: true` (see transcript-writer.ts), the
    // tool-call record landed, then the continuation arrived.
    const state = reduceAll([
      { seq: 1, kind: "text-delta", sessionId: "s1", text: "Bien re", partial: true },
      { seq: 2, kind: "tool-call", sessionId: "s1", toolCallId: "c1", toolName: "bash" },
      { seq: 3, kind: "text-delta", sessionId: "s1", text: "çu — suite." },
    ])

    // ONE sentence, not two rows — and the tool row keeps its slot and order.
    expect(state.rows.map(r => r.kind)).toEqual(["text", "tool-call"])
    expect(state.rows[0]).toMatchObject({ kind: "text", text: "Bien reçu — suite." })
    expect(state.rows[1]).toMatchObject({ kind: "tool-call", toolCallId: "c1" })
  })

  it("does NOT rejoin across a tool-call when the earlier line was terminated (control)", () => {
    const state = reduceAll([
      { seq: 1, kind: "text-delta", sessionId: "s1", text: "done.\n" },
      { seq: 2, kind: "tool-call", sessionId: "s1", toolCallId: "c1", toolName: "bash" },
      { seq: 3, kind: "text-delta", sessionId: "s1", text: "Next thing." },
    ])

    expect(state.rows.map(r => r.kind)).toEqual(["text", "tool-call", "text"])
    expect(state.rows[0]).toMatchObject({ text: "done.\n" })
    expect(state.rows[2]).toMatchObject({ text: "Next thing." })
  })

  it("does NOT rejoin across a tool-call when the earlier flush was final but unterminated", () => {
    // The writer's ordering flush (flushBuffers on the next tool-call) emits
    // the END of a text block as a non-partial record with no trailing "\n" —
    // the standard end-of-message shape, not a mid-line tear.
    const state = reduceAll([
      { seq: 1, kind: "text-delta", sessionId: "s1", text: "Checking the client." },
      { seq: 2, kind: "tool-call", sessionId: "s1", toolCallId: "c1", toolName: "bash" },
      { seq: 3, kind: "text-delta", sessionId: "s1", text: "Trial logic lives in Simone." },
    ])

    expect(state.rows.map(r => r.kind)).toEqual(["text", "tool-call", "text"])
    expect(state.rows[0]).toMatchObject({ text: "Checking the client." })
    expect(state.rows[2]).toMatchObject({ text: "Trial logic lives in Simone." })
  })

  it("never rejoins across a turn-end, even when the fragment was unterminated", () => {
    const state = reduceAll([
      { seq: 1, kind: "text-delta", sessionId: "s1", text: "cut off mid" },
      { seq: 2, kind: "turn-end", sessionId: "s1", reason: "cancelled" },
      { seq: 3, kind: "text-delta", sessionId: "s1", text: "A new turn." },
    ])

    expect(state.rows.map(r => r.kind)).toEqual(["text", "turn-end", "text"])
    expect(state.rows[2]).toMatchObject({ text: "A new turn." })
  })

  it("rejoins a session's fragment past another session's interleaved rows", () => {
    const state = reduceAll([
      { seq: 1, kind: "text-delta", sessionId: "s1", text: "Bien re", partial: true },
      { seq: 2, kind: "tool-call", sessionId: "s2", toolCallId: "c9", toolName: "bash" },
      { seq: 3, kind: "text-delta", sessionId: "s1", text: "çu." },
    ])

    expect(state.rows.map(r => r.kind)).toEqual(["text", "tool-call"])
    expect(state.rows[0]).toMatchObject({ sessionId: "s1", text: "Bien reçu." })
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

  // ── §1 adapted: usage_update now goes into state.usage, not a row ──

  it("stores usage_update in state.usage without affecting rows", () => {
    const before = initialTimelineState()
    const state = reduceEvent(before, {
      seq: 1,
      kind: "usage_update",
      sessionId: "s1",
      size: 1000,
      used: 200,
      cost: 0.05,
      tokensIn: 150,
      tokensOut: 50,
    })

    // rows stays empty — same array reference as before (no wasted copy)
    expect(state.rows).toHaveLength(0)
    expect(state.rows).toBe(before.rows)

    // usage is populated from the record
    expect(state.usage).toEqual({
      size: 1000,
      used: 200,
      cost: 0.05,
      tokensIn: 150,
      tokensOut: 50,
      seq: 1,
      ts: undefined,
    })
  })

  it("reduces a full mixed sequence deterministically (usage is state, not a row)", () => {
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

    // usage_update no longer appears in the rows
    expect(state.rows.map(r => r.kind)).toEqual(["text", "tool-call", "turn-end"])
    expect(state.rows[0]).toMatchObject({ text: "thinking..." })
    expect(state.rows[1]).toMatchObject({ status: "ok", result: "/tmp" })

    // usage is set from the last usage_update record (only size/used/seq present)
    expect(state.usage).toEqual({
      size: 500,
      used: 100,
      cost: undefined,
      tokensIn: undefined,
      tokensOut: undefined,
      seq: 7,
      ts: undefined,
    })
  })

  // ── §1 new tests ──

  it("initialTimelineState().usage is null", () => {
    const state = initialTimelineState()
    expect(state.usage).toBeNull()
  })

  it("usage before any rows sets state.usage and leaves rows empty", () => {
    const state = reduceAll([
      { seq: 1, kind: "usage_update", sessionId: "s1", size: 500, used: 100 },
    ])

    expect(state.rows).toEqual([])
    expect(state.usage).not.toBeNull()
    expect(state.usage!.size).toBe(500)
    expect(state.usage!.used).toBe(100)
    expect(state.usage!.seq).toBe(1)
  })

  it("second usage_update overwrites the first (last-write-wins)", () => {
    const state = reduceAll([
      { seq: 1, kind: "usage_update", sessionId: "s1", size: 1000, used: 200, cost: 0.05, tokensIn: 150, tokensOut: 50 },
      { seq: 2, kind: "usage_update", sessionId: "s1", size: 500, used: 100 },
    ])

    // Fields absent on the second record are absent on the snapshot (ts
    // is set to undefined here because the 2nd record has no ts field,
    // but we assert that cost/tokensIn/tokensOut are absent).
    expect(state.usage!.size).toBe(500)
    expect(state.usage!.used).toBe(100)
    expect(state.usage!.seq).toBe(2)
    // cost, tokensIn, tokensOut are absent on the new record — not carried over
    expect(state.usage!.cost).toBeUndefined()
    expect(state.usage!.tokensIn).toBeUndefined()
    expect(state.usage!.tokensOut).toBeUndefined()
  })

  it("ignores unknown kinds and returns the same state reference", () => {
    const before = initialTimelineState()
    const after = reduceEvent(before, { seq: 1, kind: "some-future-kind", sessionId: "s1" })

    expect(after).toBe(before)
    expect(after.rows).toEqual([])
    expect(after.usage).toBeNull()
  })
})

// ── WP1 — isNearBottom ──────────────────────────────────────────────

describe("isNearBottom", () => {
  it("returns true when distance is within the default threshold", () => {
    // scrollHeight=1000, scrollTop=876, clientHeight=100 → distance=24 = threshold
    expect(isNearBottom(1000, 876, 100)).toBe(true)
  })

  it("returns false when distance exceeds the default threshold", () => {
    // scrollHeight=1000, scrollTop=875, clientHeight=100 → distance=25 > 24
    expect(isNearBottom(1000, 875, 100)).toBe(false)
  })

  it("respects a custom threshold", () => {
    // distance=50, threshold=100 → true
    expect(isNearBottom(1000, 850, 100, 100)).toBe(true)
    // distance=101, threshold=100 → false
    expect(isNearBottom(1000, 799, 100, 100)).toBe(false)
  })

  it("exactly at the boundary returns true", () => {
    // distance == threshold (24)
    expect(isNearBottom(500, 376, 100)).toBe(true)
    // distance == threshold (50, custom)
    expect(isNearBottom(500, 350, 100, 50)).toBe(true)
  })

  it("returns true when already scrolled past bottom (negative distance)", () => {
    // scrollTop > scrollHeight - clientHeight → past bottom
    expect(isNearBottom(1000, 950, 100)).toBe(true) // distance = -50
    expect(isNearBottom(1000, 1000, 100)).toBe(true) // distance = -100
  })

  it("SCROLL_STICK_THRESHOLD_PX is 24", () => {
    expect(SCROLL_STICK_THRESHOLD_PX).toBe(24)
  })
})

// ── WP3 — groupAdjacentToolCalls ────────────────────────────────────

describe("groupAdjacentToolCalls", () => {
  it("TOOL_CALL_GROUP_THRESHOLD is 2", () => {
    expect(TOOL_CALL_GROUP_THRESHOLD).toBe(2)
  })

  it("empty input produces empty output", () => {
    expect(groupAdjacentToolCalls([])).toEqual([])
  })

  it("single tool-call (below threshold) passes through as individual row", () => {
    const rows = [
      { kind: "tool-call" as const, id: "tc-1", toolCallId: "c1", toolName: "bash", status: "ok" as const },
    ]
    const result = groupAdjacentToolCalls(rows)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ kind: "row", row: rows[0] })
  })

  it("run at threshold (2) is collapsed into a tool-group", () => {
    const rows = [
      { kind: "tool-call" as const, id: "tc-1", toolCallId: "c1", toolName: "bash", status: "ok" as const },
      { kind: "tool-call" as const, id: "tc-2", toolCallId: "c2", toolName: "read_file", status: "ok" as const },
    ]
    const result = groupAdjacentToolCalls(rows)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ kind: "tool-group", rows: [rows[0], rows[1]] })
  })

  it("long run (5) is collapsed into a single tool-group", () => {
    const rows = [
      { kind: "tool-call" as const, id: "tc-1", toolCallId: "c1", toolName: "bash", status: "ok" as const },
      { kind: "tool-call" as const, id: "tc-2", toolCallId: "c2", toolName: "bash", status: "ok" as const },
      { kind: "tool-call" as const, id: "tc-3", toolCallId: "c3", toolName: "read_file", status: "ok" as const },
      { kind: "tool-call" as const, id: "tc-4", toolCallId: "c4", toolName: "think", status: "pending" as const },
      { kind: "tool-call" as const, id: "tc-5", toolCallId: "c5", toolName: "bash", status: "error" as const },
    ]
    const result = groupAdjacentToolCalls(rows)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ kind: "tool-group", rows })
  })

  it("run broken by a text row produces separate groups", () => {
    const tools = [
      { kind: "tool-call" as const, id: "tc-1", toolCallId: "c1", toolName: "bash", status: "ok" as const },
      { kind: "tool-call" as const, id: "tc-2", toolCallId: "c2", toolName: "read_file", status: "ok" as const },
    ]
    const text = { kind: "text" as const, id: "tx-1", text: "thinking..." }
    const moreTools = [
      { kind: "tool-call" as const, id: "tc-3", toolCallId: "c3", toolName: "bash", status: "pending" as const },
      { kind: "tool-call" as const, id: "tc-4", toolCallId: "c4", toolName: "read_file", status: "ok" as const },
    ]
    const result = groupAdjacentToolCalls([...tools, text, ...moreTools])
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ kind: "tool-group", rows: tools })
    expect(result[1]).toEqual({ kind: "row", row: text })
    expect(result[2]).toEqual({ kind: "tool-group", rows: moreTools })
  })

  it("run broken by a turn-end produces separate groups", () => {
    const tools = [
      { kind: "tool-call" as const, id: "tc-1", toolCallId: "c1", toolName: "bash", status: "ok" as const },
      { kind: "tool-call" as const, id: "tc-2", toolCallId: "c2", toolName: "read_file", status: "ok" as const },
    ]
    const turnEnd = { kind: "turn-end" as const, id: "te-1", reason: "done" }
    const singleTool = [
      { kind: "tool-call" as const, id: "tc-3", toolCallId: "c3", toolName: "bash", status: "pending" as const },
    ]
    const result = groupAdjacentToolCalls([...tools, turnEnd, ...singleTool])
    // tools (2) → group, turn-end → row, singleTool (1) → individual row
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ kind: "tool-group", rows: tools })
    expect(result[1]).toEqual({ kind: "row", row: turnEnd })
    expect(result[2]).toEqual({ kind: "row", row: singleTool[0] })
  })

  it("non-tool-call rows pass through unchanged as individual rows", () => {
    const rows = [
      { kind: "text" as const, id: "tx-1", text: "hello" },
      { kind: "turn-end" as const, id: "te-1", reason: "stop" },
      { kind: "text" as const, id: "tx-2", text: "world" },
    ]
    const result = groupAdjacentToolCalls(rows)
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ kind: "row", row: rows[0] })
    expect(result[1]).toEqual({ kind: "row", row: rows[1] })
    expect(result[2]).toEqual({ kind: "row", row: rows[2] })
  })

  it("respects custom threshold", () => {
    const rows = [
      { kind: "tool-call" as const, id: "tc-1", toolCallId: "c1", toolName: "bash", status: "ok" as const },
      { kind: "tool-call" as const, id: "tc-2", toolCallId: "c2", toolName: "bash", status: "ok" as const },
      { kind: "tool-call" as const, id: "tc-3", toolCallId: "c3", toolName: "bash", status: "ok" as const },
    ]
    // threshold=3 → group; threshold=4 → individual rows
    expect(groupAdjacentToolCalls(rows, 3)).toHaveLength(1)
    expect(groupAdjacentToolCalls(rows, 3)[0]!.kind).toBe("tool-group")

    expect(groupAdjacentToolCalls(rows, 4)).toHaveLength(3)
    expect(groupAdjacentToolCalls(rows, 4).every(e => e.kind === "row")).toBe(true)
  })

  it("preserves order covering every input row exactly once", () => {
    // A mixed sequence that exercises every path
    const rows = [
      { kind: "tool-call" as const, id: "tc-1", toolCallId: "c1", toolName: "bash", status: "ok" as const },
      { kind: "tool-call" as const, id: "tc-2", toolCallId: "c2", toolName: "read_file", status: "ok" as const },
      { kind: "text" as const, id: "tx-1", text: "check" },
      { kind: "text" as const, id: "tx-2", text: "more" },
      { kind: "tool-call" as const, id: "tc-3", toolCallId: "c3", toolName: "bash", status: "pending" as const },
      { kind: "turn-end" as const, id: "te-1", reason: "done" },
      { kind: "tool-call" as const, id: "tc-4", toolCallId: "c4", toolName: "think", status: "ok" as const },
    ]
    const result = groupAdjacentToolCalls(rows)
    // tc-1,tc-2 (2) → group; tx-1 → row; tx-2 → row; tc-3 (1) → row; te-1 → row; tc-4 (1) → row
    expect(result).toHaveLength(6)
    expect(result[0]).toEqual({ kind: "tool-group", rows: [rows[0], rows[1]] })
    expect(result[1]).toEqual({ kind: "row", row: rows[2] })
    expect(result[2]).toEqual({ kind: "row", row: rows[3] })
    expect(result[3]).toEqual({ kind: "row", row: rows[4] })
    expect(result[4]).toEqual({ kind: "row", row: rows[5] })
    expect(result[5]).toEqual({ kind: "row", row: rows[6] })

    // Confirm every input row is covered exactly once (flatten)
    const covered = result.flatMap(e => (e.kind === "tool-group" ? e.rows : [e.row]))
    expect(covered).toEqual(rows)
  })
})
describe("extractToolResultSessionId", () => {
  const asResult = (body: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(body) }],
  })

  it("pins the spawned session from an agent_start descriptor (id field)", () => {
    const descriptor = { id: "sess_5d820e69", label: "agent-apps-reorg", status: "running" }
    expect(extractToolResultSessionId(asResult(descriptor))).toBe("sess_5d820e69")
  })

  it("pins from a live_session result (sessionId field), preferring it over id", () => {
    expect(
      extractToolResultSessionId(asResult({ sessionId: "sess_aaa", id: "sess_bbb" })),
    ).toBe("sess_aaa")
  })

  it("unwraps a params.result nesting", () => {
    expect(
      extractToolResultSessionId({ result: asResult({ id: "sess_ccc" }) }),
    ).toBe("sess_ccc")
  })

  it("returns null for error results, non-JSON text, and shape mismatches", () => {
    expect(
      extractToolResultSessionId({ isError: true, content: [{ type: "text", text: "{\"id\":\"x\"}" }] }),
    ).toBeNull()
    expect(
      extractToolResultSessionId(asResult({ sessionId: undefined, httpBaseUrl: "http://x" })),
    ).toBeNull()
    expect(
      extractToolResultSessionId({ content: [{ type: "text", text: "agent_start: adapter is required" }] }),
    ).toBeNull()
    expect(extractToolResultSessionId(null)).toBeNull()
    expect(extractToolResultSessionId("nope")).toBeNull()
    expect(extractToolResultSessionId({ content: [] })).toBeNull()
  })
})
