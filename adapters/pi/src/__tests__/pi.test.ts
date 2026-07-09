import { describe, expect, it } from "vitest"
import { pi, piRuntime } from "../index.js"
import {
  classifyPiLine,
  createPiMapperState,
  mapPiEvent,
  mapStopReason,
  type PiSessionEvent,
} from "../pi-events.js"

describe("@agentproto/adapter-pi — manifest", () => {
  it("exposes a validated AIP-45 proprietary handle", () => {
    expect(pi.id).toBe("pi")
    expect(pi.protocol).toBe("proprietary")
    expect(pi.adapter).toBe("@agentproto/adapter-pi")
    expect(pi.bin).toBe("pi")
    // No throw from defineAgentCli means the manifest is schema-valid.
    expect(typeof pi.version).toBe("string")
  })

  it("declares RPC-appropriate capabilities incl. no MCP/sub-agents", () => {
    expect(pi.capabilities?.streaming).toBe(true)
    expect(pi.capabilities?.tool_calls).toBe(true)
    expect(pi.capabilities?.bidirectional).toBe(true)
    expect(pi.capabilities?.resumable).toBe(true)
    // Pi orchestrates via the MCP bridge: with the daemon's gateway injected,
    // `agent_start` becomes a pi tool (verified end-to-end).
    expect(pi.capabilities?.sub_agents).toBe(true)
  })

  it("declares the 3 provider env slots and a native-resume continuation", () => {
    expect(pi.auth?.state?.env).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
    ])
    expect(pi.continuation?.default).toBe("native-resume")
    expect(pi.continuation?.supported).toContain("native-resume")
  })

  it("declares model + effort options with pi's thinking levels", () => {
    const effort = pi.options?.find(o => o.id === "effort")
    expect(effort?.enum).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"])
    expect(pi.options?.some(o => o.id === "model")).toBe(true)
  })

  it("piRuntime returns a runtime bound to the pi handle", () => {
    const runtime = piRuntime()
    expect(runtime.definition).toBe(pi)
    expect(typeof runtime.start).toBe("function")
  })
})

const SID = "sess-123"

describe("mapPiEvent", () => {
  it("maps an assistant text_delta to text-delta", () => {
    const state = createPiMapperState()
    const event: PiSessionEvent = {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    }
    expect(mapPiEvent(event, SID, state)).toEqual([
      { kind: "text-delta", sessionId: SID, text: "Hello" },
    ])
  })

  it("maps a thinking_delta to thought", () => {
    const state = createPiMapperState()
    const event: PiSessionEvent = {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "reasoning..." },
    }
    expect(mapPiEvent(event, SID, state)).toEqual([
      { kind: "thought", sessionId: SID, text: "reasoning..." },
    ])
  })

  it("maps tool_execution_start to tool-call", () => {
    const state = createPiMapperState()
    const event: PiSessionEvent = {
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "bash",
      args: { command: "ls" },
    }
    expect(mapPiEvent(event, SID, state)).toEqual([
      {
        kind: "tool-call",
        sessionId: SID,
        toolCallId: "tc1",
        toolName: "bash",
        arguments: { command: "ls" },
      },
    ])
  })

  it("maps tool_execution_end to tool-result (incl. isError)", () => {
    const state = createPiMapperState()
    const ok: PiSessionEvent = {
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "bash",
      result: "file.txt",
      isError: false,
    }
    expect(mapPiEvent(ok, SID, state)).toEqual([
      { kind: "tool-result", sessionId: SID, toolCallId: "tc1", result: "file.txt", isError: false },
    ])
    const bad: PiSessionEvent = {
      type: "tool_execution_end",
      toolCallId: "tc2",
      toolName: "bash",
      result: "boom",
      isError: true,
    }
    expect(mapPiEvent(bad, SID, state)).toEqual([
      { kind: "tool-result", sessionId: SID, toolCallId: "tc2", result: "boom", isError: true },
    ])
  })

  it("emits usage_update from turn_end assistant usage", () => {
    const state = createPiMapperState()
    const event: PiSessionEvent = {
      type: "turn_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0.0021 } },
      },
    }
    expect(mapPiEvent(event, SID, state)).toEqual([
      {
        kind: "usage_update",
        sessionId: SID,
        size: 120,
        used: 120,
        cost: { amount: 0.0021, currency: "USD" },
        tokensIn: 100,
        tokensOut: 20,
      },
    ])
  })

  it("closes a normal turn with turn-end{completed} on terminal agent_end", () => {
    const state = createPiMapperState()
    mapPiEvent(
      { type: "message_update", assistantMessageEvent: { type: "done", reason: "stop" } },
      SID,
      state,
    )
    expect(mapPiEvent({ type: "agent_end", willRetry: false }, SID, state)).toEqual([
      { kind: "turn-end", sessionId: SID, reason: "completed" },
    ])
  })

  it("maps aborted → turn-end{cancelled}", () => {
    const state = createPiMapperState()
    mapPiEvent(
      { type: "message_update", assistantMessageEvent: { type: "error", reason: "aborted" } },
      SID,
      state,
    )
    expect(mapPiEvent({ type: "agent_end", willRetry: false }, SID, state)).toEqual([
      { kind: "turn-end", sessionId: SID, reason: "cancelled" },
    ])
  })

  it("maps length → turn-end{max_turns}", () => {
    const state = createPiMapperState()
    mapPiEvent(
      { type: "turn_end", message: { role: "assistant", stopReason: "length" } },
      SID,
      state,
    )
    expect(mapPiEvent({ type: "agent_end", willRetry: false }, SID, state)).toEqual([
      { kind: "turn-end", sessionId: SID, reason: "max_turns" },
    ])
  })

  it("emits an error event and turn-end{error} on an assistant error", () => {
    const state = createPiMapperState()
    const err = mapPiEvent(
      {
        type: "message_update",
        assistantMessageEvent: { type: "error", reason: "error", errorMessage: "rate limited" },
      },
      SID,
      state,
    )
    expect(err).toEqual([
      { kind: "error", sessionId: SID, error: { message: "rate limited" } },
    ])
    expect(mapPiEvent({ type: "agent_end", willRetry: false }, SID, state)).toEqual([
      { kind: "turn-end", sessionId: SID, reason: "error" },
    ])
  })

  it("defaults an unknown/absent stop reason to completed", () => {
    expect(mapStopReason(undefined)).toBe("completed")
    expect(mapStopReason("toolUse")).toBe("completed")
    const state = createPiMapperState()
    expect(mapPiEvent({ type: "agent_end", willRetry: false }, SID, state)).toEqual([
      { kind: "turn-end", sessionId: SID, reason: "completed" },
    ])
  })

  it("ignores lifecycle-only events (and agent_settled, which pi never streams)", () => {
    const state = createPiMapperState()
    expect(mapPiEvent({ type: "agent_start" }, SID, state)).toEqual([])
    expect(mapPiEvent({ type: "turn_start" }, SID, state)).toEqual([])
    expect(mapPiEvent({ type: "agent_settled" }, SID, state)).toEqual([])
  })

  it("does NOT close the turn on a willRetry agent_end (auto-retry continues)", () => {
    const state = createPiMapperState()
    expect(mapPiEvent({ type: "agent_end", willRetry: true }, SID, state)).toEqual([])
    // The eventual terminal agent_end closes it.
    expect(mapPiEvent({ type: "agent_end", willRetry: false }, SID, state)).toEqual([
      { kind: "turn-end", sessionId: SID, reason: "completed" },
    ])
  })
})

describe("classifyPiLine", () => {
  it("classifies a response line", () => {
    const out = classifyPiLine(
      JSON.stringify({ id: "1", type: "response", command: "get_state", success: true, data: { sessionId: "abc" } }),
    )
    expect(out.kind).toBe("response")
    if (out.kind === "response") {
      expect(out.response.command).toBe("get_state")
      expect(out.response.success).toBe(true)
    }
  })

  it("classifies a session event line", () => {
    const out = classifyPiLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }),
    )
    expect(out.kind).toBe("event")
    if (out.kind === "event") {
      expect(out.event.type).toBe("message_update")
    }
  })

  it("treats malformed JSON, unknown types and extension-UI lines as other", () => {
    expect(classifyPiLine("not json").kind).toBe("other")
    expect(classifyPiLine(JSON.stringify({ type: "queue_update" })).kind).toBe("other")
    expect(
      classifyPiLine(JSON.stringify({ type: "extension_ui_request", id: "x", method: "confirm" })).kind,
    ).toBe("other")
  })
})
