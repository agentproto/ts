/**
 * jcode NDJSON mapper — unit coverage against REAL captured wire lines
 * from `jcode run --ndjson` (captured 2026-08-14). The old jcode arm
 * spawned `jcode run` with NO output format: plain-text stdout failed the
 * print arm's per-line JSON.parse and every reply was silently dropped —
 * a session that "never replies". These fixtures pin the NDJSON taxonomy
 * the fixed arm actually consumes.
 */
import { describe, expect, it } from "vitest"

import { createJcodeMapperState, mapJcodeEvent } from "../protocol/print-arm.js"

const SID = "session_rooster_1786661811156_111c9b0a12d0e0cf"

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>
}

describe("mapJcodeEvent — text turn", () => {
  it("maps text_delta to text-delta", () => {
    const state = createJcodeMapperState()
    const evt = mapJcodeEvent(parse('{"text":"pong","type":"text_delta"}'), SID, state)
    expect(evt).toEqual({ kind: "text-delta", sessionId: SID, text: "pong" })
  })

  it("maps tokens to usage_update with zero size/used (no window info on the wire)", () => {
    const state = createJcodeMapperState()
    const evt = mapJcodeEvent(
      parse('{"cache_creation_input":null,"cache_read_input":62315,"input":63130,"output":5,"type":"tokens"}'),
      SID,
      state,
    )
    expect(evt).toEqual({
      kind: "usage_update",
      sessionId: SID,
      size: 0,
      used: 0,
      tokensIn: 63130,
      tokensOut: 5,
    })
  })

  it("maps the terminal done to turn-end completed", () => {
    const state = createJcodeMapperState()
    const evt = mapJcodeEvent(parse(`{"text":"pong","type":"done","session_id":"${SID}"}`), SID, state)
    expect(evt).toEqual({ kind: "turn-end", sessionId: SID, reason: "completed" })
  })

  it("drops connection noise and message_end", () => {
    const state = createJcodeMapperState()
    for (const line of [
      '{"detail":"opening websocket","type":"status_detail"}',
      '{"phase":"connecting","type":"connection_phase"}',
      '{"connection":"websocket/persistent-fresh","type":"connection_type"}',
      '{"stop_reason":null,"type":"message_end"}',
      `{"model":"gpt-5.6-sol","provider":"OpenAI","session_id":"${SID}","type":"start"}`,
    ]) {
      expect(mapJcodeEvent(parse(line), SID, state)).toBeNull()
    }
  })
})

describe("mapJcodeEvent — tool round-trip", () => {
  it("accumulates tool_input deltas and emits the call on tool_exec, the result on tool_done", () => {
    const state = createJcodeMapperState()
    expect(
      mapJcodeEvent(parse('{"id":"call_1","name":"bash","type":"tool_start"}'), SID, state),
    ).toBeNull()
    expect(
      mapJcodeEvent(
        parse('{"delta":"{\\"command\\":\\"echo hi\\"}","type":"tool_input"}'),
        SID,
        state,
      ),
    ).toBeNull()

    const call = mapJcodeEvent(parse('{"id":"call_1","name":"bash","type":"tool_exec"}'), SID, state)
    expect(call).toEqual({
      kind: "tool-call",
      sessionId: SID,
      toolCallId: "call_1",
      toolName: "bash",
      arguments: { command: "echo hi" },
    })

    const result = mapJcodeEvent(
      parse('{"error":null,"id":"call_1","name":"bash","output":"hi\\n","type":"tool_done"}'),
      SID,
      state,
    )
    expect(result).toEqual({
      kind: "tool-result",
      sessionId: SID,
      toolCallId: "call_1",
      result: "hi\n",
      isError: false,
    })
  })

  it("flushes an un-exec'd pending call on tool_done so the result is never orphaned", () => {
    const state = createJcodeMapperState()
    mapJcodeEvent(parse('{"id":"call_2","name":"bash","type":"tool_start"}'), SID, state)
    mapJcodeEvent(parse('{"delta":"{}","type":"tool_input"}'), SID, state)
    const events = mapJcodeEvent(
      parse('{"error":"boom","id":"call_2","name":"bash","output":null,"type":"tool_done"}'),
      SID,
      state,
    )
    expect(Array.isArray(events)).toBe(true)
    const [call, result] = events as unknown as [Record<string, unknown>, Record<string, unknown>]
    expect(call.kind).toBe("tool-call")
    expect(result).toMatchObject({ kind: "tool-result", toolCallId: "call_2", isError: true })
  })

  it("keeps unparseable tool input as { raw } instead of throwing mid-stream", () => {
    const state = createJcodeMapperState()
    mapJcodeEvent(parse('{"id":"call_3","name":"bash","type":"tool_start"}'), SID, state)
    mapJcodeEvent(parse('{"delta":"not json","type":"tool_input"}'), SID, state)
    const call = mapJcodeEvent(parse('{"id":"call_3","name":"bash","type":"tool_exec"}'), SID, state)
    expect(call).toMatchObject({ kind: "tool-call", arguments: { raw: "not json" } })
  })
})
