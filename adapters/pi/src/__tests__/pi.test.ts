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

  it("declares RPC-appropriate capabilities incl. MCP-bridged sub-agents", () => {
    expect(pi.capabilities?.streaming).toBe(true)
    expect(pi.capabilities?.tool_calls).toBe(true)
    expect(pi.capabilities?.bidirectional).toBe(true)
    expect(pi.capabilities?.resumable).toBe(true)
    // Pi orchestrates via the MCP bridge: with the daemon's gateway injected,
    // `agent_start` becomes a pi tool (verified end-to-end).
    expect(pi.capabilities?.sub_agents).toBe(true)
  })

  it("declares the auth env slots (incl. the anthropic bearer door) and a native-resume continuation", () => {
    expect(pi.auth?.state?.env).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "MOONSHOT_API_KEY",
    ])
    expect(pi.continuation?.default).toBe("native-resume")
    expect(pi.continuation?.supported).toContain("native-resume")
  })

  it("declares the anthropic-scoped subscription surface (ANTHROPIC_OAUTH_TOKEN)", () => {
    // Pi's own bearer door — `ANTHROPIC_OAUTH_TOKEN — Anthropic OAuth token
    // (alternative to API key)` (pi 0.80.x --help). Scoped to anthropic so a
    // Claude subscription profile lights up pi's anthropic models only.
    expect(pi.authSubscription).toEqual({
      setEnv: "ANTHROPIC_OAUTH_TOKEN",
      provider: "anthropic",
    })
  })

  it("declares model + effort options with pi's thinking levels", () => {
    const effort = pi.options?.find(o => o.id === "effort")
    expect(effort?.enum).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"])
    expect(pi.options?.some(o => o.id === "model")).toBe(true)
  })

  // D3: the model-id PREFIX and the BILLING provider are two different facts
  // and this entry is where they diverge. `moonshotai/` is pi's own wire
  // spelling (its `--model` resolver expects it); `moonshot` is the canonical
  // catalog provider the runtime bills against. This test previously asserted
  // `provider: "moonshotai"` — it encoded the bug: that slug is not a member
  // of CatalogProviderSchema, so serve.ts's projection silently DROPPED pi's
  // per-model provider and the resolver fell through to the global catalog's
  // routing for the id (openrouter), making a valid moonshot profile look
  // ineligible.
  it("declares the Moonshot model entry with the CANONICAL billing provider", () => {
    expect(
      pi.models?.allowed?.some(
        m => typeof m === "object" && m.id === "moonshotai/kimi-k3" && m.provider === "moonshot",
      ),
    ).toBe(true)
    expect(
      pi.models?.allowed?.some(
        m => typeof m === "object" && m.id === "moonshotai/kimi-k2.7-code" && m.provider === "moonshot",
      ),
    ).toBe(true)
    // env is keyed by the canonical provider slug, matching `provider` above.
    expect(pi.models?.env?.moonshot).toBe("MOONSHOT_API_KEY")
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
    expect(mapPiEvent(event, SID, state, undefined)).toEqual([
      { kind: "text-delta", sessionId: SID, text: "Hello" },
    ])
  })

  it("maps a thinking_delta to thought", () => {
    const state = createPiMapperState()
    const event: PiSessionEvent = {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "reasoning..." },
    }
    expect(mapPiEvent(event, SID, state, undefined)).toEqual([
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
    expect(mapPiEvent(event, SID, state, undefined)).toEqual([
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
    expect(mapPiEvent(ok, SID, state, undefined)).toEqual([
      { kind: "tool-result", sessionId: SID, toolCallId: "tc1", result: "file.txt", isError: false },
    ])
    const bad: PiSessionEvent = {
      type: "tool_execution_end",
      toolCallId: "tc2",
      toolName: "bash",
      result: "boom",
      isError: true,
    }
    expect(mapPiEvent(bad, SID, state, undefined)).toEqual([
      { kind: "tool-result", sessionId: SID, toolCallId: "tc2", result: "boom", isError: true },
    ])
  })

  it("emits usage_update with the resolved model context window as size, NOT the token total", () => {
    const state = createPiMapperState()
    const event: PiSessionEvent = {
      type: "turn_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0.0021 } },
      },
    }
    // contextWindow resolved (e.g. by client.ts from @agentproto/model-catalog) —
    // `size` must be the real window, never the turn's own token total (that
    // was the bug: size === used pinned contextPct at 100% on turn 1).
    expect(mapPiEvent(event, SID, state, 262144)).toEqual([
      {
        kind: "usage_update",
        sessionId: SID,
        size: 262144,
        used: 120,
        cost: { amount: 0.0021, currency: "USD" },
        tokensIn: 100,
        tokensOut: 20,
      },
    ])
  })

  it("sends size: 0 (unknown-window sentinel) when the model's context window isn't resolvable", () => {
    const state = createPiMapperState()
    const event: PiSessionEvent = {
      type: "turn_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0.0021 } },
      },
    }
    // contextWindow undefined (unknown model) — size must NOT fall back to
    // totalTokens (or any other used-derived number); it must be the
    // explicit 0 sentinel the runtime's usage_update ingestion (`evt.size >
    // 0` guard, packages/runtime/src/sessions.ts) knows to ignore.
    expect(mapPiEvent(event, SID, state, undefined)).toEqual([
      {
        kind: "usage_update",
        sessionId: SID,
        size: 0,
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
      undefined,
    )
    expect(mapPiEvent({ type: "agent_end", willRetry: false }, SID, state, undefined)).toEqual([
      { kind: "turn-end", sessionId: SID, reason: "completed" },
    ])
  })

  it("maps aborted → turn-end{cancelled}", () => {
    const state = createPiMapperState()
    mapPiEvent(
      { type: "message_update", assistantMessageEvent: { type: "error", reason: "aborted" } },
      SID,
      state,
      undefined,
    )
    expect(mapPiEvent({ type: "agent_end", willRetry: false }, SID, state, undefined)).toEqual([
      { kind: "turn-end", sessionId: SID, reason: "cancelled" },
    ])
  })

  it("maps length → turn-end{max_turns}", () => {
    const state = createPiMapperState()
    mapPiEvent(
      { type: "turn_end", message: { role: "assistant", stopReason: "length" } },
      SID,
      state,
      undefined,
    )
    expect(mapPiEvent({ type: "agent_end", willRetry: false }, SID, state, undefined)).toEqual([
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
      undefined,
    )
    expect(err).toEqual([
      { kind: "error", sessionId: SID, error: { message: "rate limited" } },
    ])
    expect(mapPiEvent({ type: "agent_end", willRetry: false }, SID, state, undefined)).toEqual([
      { kind: "turn-end", sessionId: SID, reason: "error" },
    ])
  })

  it("defaults an unknown/absent stop reason to completed", () => {
    expect(mapStopReason(undefined)).toBe("completed")
    expect(mapStopReason("toolUse")).toBe("completed")
    const state = createPiMapperState()
    expect(mapPiEvent({ type: "agent_end", willRetry: false }, SID, state, undefined)).toEqual([
      { kind: "turn-end", sessionId: SID, reason: "completed" },
    ])
  })

  it("ignores lifecycle-only events (and agent_settled, which pi never streams)", () => {
    const state = createPiMapperState()
    expect(mapPiEvent({ type: "agent_start" }, SID, state, undefined)).toEqual([])
    expect(mapPiEvent({ type: "turn_start" }, SID, state, undefined)).toEqual([])
    expect(mapPiEvent({ type: "agent_settled" }, SID, state, undefined)).toEqual([])
  })

  it("does NOT close the turn on a willRetry agent_end (auto-retry continues)", () => {
    const state = createPiMapperState()
    expect(mapPiEvent({ type: "agent_end", willRetry: true }, SID, state, undefined)).toEqual([])
    // The eventual terminal agent_end closes it.
    expect(mapPiEvent({ type: "agent_end", willRetry: false }, SID, state, undefined)).toEqual([
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
