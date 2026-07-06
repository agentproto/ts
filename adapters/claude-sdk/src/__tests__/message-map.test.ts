import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it } from "vitest"
import {
  assistantMessageUpdates,
  resultUsageUpdate,
  sdkMessageToUpdates,
  streamEventUpdates,
  systemInitSessionId,
  toolCallTitle,
  toolKindForClaudeTool,
  userMessageUpdates,
} from "../message-map.js"

/** Minimal typed fakes — we only populate the fields the mapping reads.
 *  The single boundary cast keeps the literals small; the mapping under test
 *  stays fully typed. */
function assistant(
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; signature: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >,
): SDKAssistantMessage {
  return { type: "assistant", message: { content } } as unknown as SDKAssistantMessage
}

/** A `stream_event` partial-assistant message carrying one raw stream frame. */
function streamEvent(event: unknown): SDKPartialAssistantMessage {
  return { type: "stream_event", event } as unknown as SDKPartialAssistantMessage
}

function user(
  content:
    | string
    | Array<{ type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean }>,
): SDKUserMessage {
  return { type: "user", message: { content } } as unknown as SDKUserMessage
}

function result(over: Partial<SDKResultMessage> = {}): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    total_cost_usd: 0.0021,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {
      "claude-haiku-4-5-20251001": { contextWindow: 200000 },
    },
    ...over,
  } as unknown as SDKResultMessage
}

function initMsg(sessionId: string): SDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
  } as unknown as SDKSystemMessage
}

describe("toolKindForClaudeTool", () => {
  it("maps built-in Claude tools to ACP kinds", () => {
    expect(toolKindForClaudeTool("Read")).toBe("read")
    expect(toolKindForClaudeTool("Edit")).toBe("edit")
    expect(toolKindForClaudeTool("Bash")).toBe("execute")
    expect(toolKindForClaudeTool("Grep")).toBe("search")
    expect(toolKindForClaudeTool("WebFetch")).toBe("fetch")
    expect(toolKindForClaudeTool("mcp__x__y")).toBe("other")
  })
})

describe("toolCallTitle", () => {
  it("annotates with the salient arg", () => {
    expect(toolCallTitle("Bash", { command: "ls -la" })).toBe("Bash: ls -la")
    expect(toolCallTitle("Read", { file_path: "src/x.ts" })).toBe("Read: src/x.ts")
    expect(toolCallTitle("Grep", { pattern: "TODO" })).toBe("Grep: TODO")
    expect(toolCallTitle("Task", {})).toBe("Task")
  })
})

describe("assistantMessageUpdates", () => {
  it("emits agent_message_chunk per text block and tool_call per tool_use", () => {
    const updates = assistantMessageUpdates(
      assistant([
        { type: "text", text: "let me look" },
        { type: "tool_use", id: "tc1", name: "Bash", input: { command: "ls" } },
      ]),
    )
    expect(updates.map((u) => u.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "tool_call",
    ])
    expect(updates[1]).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      kind: "execute",
      status: "in_progress",
      title: "Bash: ls",
    })
  })

  it("drops empty text blocks", () => {
    expect(assistantMessageUpdates(assistant([{ type: "text", text: "" }]))).toEqual([])
  })

  it("does not surface a complete `thinking` block (thinking streams as deltas only)", () => {
    expect(
      assistantMessageUpdates(
        assistant([{ type: "thinking", thinking: "reasoning…", signature: "" }]),
      ),
    ).toEqual([])
  })

  it("suppressText drops text but keeps tool_call — the streamed-prose dedup path", () => {
    const updates = assistantMessageUpdates(
      assistant([
        { type: "text", text: "already streamed" },
        { type: "tool_use", id: "tc1", name: "Bash", input: { command: "ls" } },
      ]),
      true,
    )
    expect(updates.map((u) => u.sessionUpdate)).toEqual(["tool_call"])
  })
})

describe("streamEventUpdates", () => {
  it("maps a text_delta to agent_message_chunk", () => {
    expect(
      streamEventUpdates(
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hel" },
        }),
      ),
    ).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } },
    ])
  })

  it("maps a thinking_delta to agent_thought_chunk", () => {
    expect(
      streamEventUpdates(
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "let me reason" },
        }),
      ),
    ).toEqual([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "let me reason" } },
    ])
  })

  it("ignores empty deltas and non-delta frames (starts/stops, message-level, input_json)", () => {
    expect(
      streamEventUpdates(
        streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }),
      ),
    ).toEqual([])
    expect(
      streamEventUpdates(streamEvent({ type: "content_block_start", index: 0 })),
    ).toEqual([])
    expect(streamEventUpdates(streamEvent({ type: "message_stop" }))).toEqual([])
    expect(
      streamEventUpdates(
        streamEvent({
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"a":' },
        }),
      ),
    ).toEqual([])
  })
})

describe("userMessageUpdates", () => {
  it("maps tool_result blocks to tool_call_update", () => {
    const updates = userMessageUpdates(
      user([
        { type: "tool_result", tool_use_id: "tc1", content: "ok" },
        { type: "tool_result", tool_use_id: "tc2", content: "boom", is_error: true },
      ]),
    )
    expect(updates).toEqual([
      { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed", rawOutput: "ok" },
      { sessionUpdate: "tool_call_update", toolCallId: "tc2", status: "failed", rawOutput: "boom" },
    ])
  })

  it("ignores a plain-string user echo", () => {
    expect(userMessageUpdates(user("hello"))).toEqual([])
  })
})

describe("resultUsageUpdate", () => {
  it("maps native Anthropic usage to a usage_update", () => {
    const u = resultUsageUpdate(result())
    expect(u.sessionUpdate).toBe("usage_update")
    expect(u.size).toBe(200000)
    // input(100) + cacheRead(5) + cacheCreate(0) = 105 in, output 20 => used 125
    expect(u.tokensIn).toBe(105)
    expect(u.tokensOut).toBe(20)
    expect(u.used).toBe(125)
    expect(u.cost).toEqual({ amount: 0.0021, currency: "USD" })
  })
})

describe("sdkMessageToUpdates / systemInitSessionId", () => {
  it("dispatches by message type", () => {
    expect(sdkMessageToUpdates(assistant([{ type: "text", text: "hi" }]))).toHaveLength(1)
    expect(sdkMessageToUpdates(result())).toHaveLength(1)
    expect(sdkMessageToUpdates(initMsg("s1"))).toEqual([])
    expect(
      sdkMessageToUpdates(
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hi" },
        }),
      ),
    ).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
    ])
  })

  it("forwards suppressAssistantText so a streamed turn's complete message drops its prose", () => {
    const msg = assistant([
      { type: "text", text: "streamed already" },
      { type: "tool_use", id: "tc1", name: "Bash", input: { command: "ls" } },
    ])
    expect(sdkMessageToUpdates(msg, { suppressAssistantText: true }).map((u) => u.sessionUpdate)).toEqual([
      "tool_call",
    ])
    // Default (no partials seen this turn) keeps the prose.
    expect(sdkMessageToUpdates(msg).map((u) => u.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "tool_call",
    ])
  })

  it("extracts session_id only from system/init", () => {
    expect(systemInitSessionId(initMsg("abc"))).toBe("abc")
    expect(systemInitSessionId(assistant([{ type: "text", text: "x" }]))).toBeNull()
  })
})
