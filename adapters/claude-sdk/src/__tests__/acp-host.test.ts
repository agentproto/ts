import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it } from "vitest"
import { ClaudeSdkAcpAgent, type QueryFn } from "../acp-host.js"

/** Capture the `update` payloads the host pushes via sessionUpdate. */
function fakeConn(sink: unknown[]): AgentSideConnection {
  return {
    sessionUpdate: async (p: { update: unknown }) => {
      sink.push(p.update)
    },
  } as unknown as AgentSideConnection
}

/** An async-generator `query` fake: yields a fixed SDK message stream and
 *  records the Options it was called with. No live Anthropic key needed. */
function fakeQuery(
  messages: SDKMessage[],
  calls: Array<{ prompt: unknown; options?: Options }>,
): QueryFn {
  return ({ prompt, options }) => {
    calls.push({ prompt, options })
    return (async function* () {
      for (const m of messages) yield m
    })()
  }
}

function initMsg(sessionId: string): SDKMessage {
  return { type: "system", subtype: "init", session_id: sessionId } as unknown as SDKMessage
}
function assistantMsg(text: string): SDKMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  } as unknown as SDKMessage
}
function toolUseMsg(toolUseId: string, name: string): SDKMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: toolUseId, name, input: {} }] },
  } as unknown as SDKMessage
}
function toolResultMsg(toolUseId: string): SDKMessage {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
  } as unknown as SDKMessage
}
function resultMsg(): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    total_cost_usd: 0.0001,
    usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { "claude-haiku-4-5-20251001": { contextWindow: 200000 } },
  } as unknown as SDKMessage
}
/** A `stream_event` partial-assistant frame — one extended-thinking delta. */
function thinkingDelta(text: string): SDKMessage {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: text },
    },
  } as unknown as SDKMessage
}
/** A `stream_event` partial-assistant frame — one assistant-prose text delta. */
function textDelta(text: string): SDKMessage {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text },
    },
  } as unknown as SDKMessage
}

describe("ClaudeSdkAcpAgent — smoke (faked SDK stream)", () => {
  it("streams a message + usage and ends the turn on a trivial prompt", async () => {
    const updates: Array<Record<string, unknown>> = []
    const calls: Array<{ prompt: unknown; options?: Options }> = []
    const query = fakeQuery(
      [initMsg("sdk-sess-1"), assistantMsg("OK"), resultMsg()],
      calls,
    )
    const host = new ClaudeSdkAcpAgent(fakeConn(updates), { model: "claude-haiku-4-5-20251001" }, query)

    const { sessionId } = await host.newSession({ cwd: "/tmp", mcpServers: [] } as never)
    const res = await host.prompt({
      sessionId,
      prompt: [{ type: "text", text: "reply OK" }],
    } as never)

    expect(res.stopReason).toBe("end_turn")
    expect(updates.map((u) => u.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "usage_update",
    ])
    expect((updates[0]!.content as { text: string }).text).toBe("OK")
    expect(updates[1]).toMatchObject({ sessionUpdate: "usage_update", cost: { currency: "USD" } })

    // First turn pins the session UUID via options.sessionId (matches the ACP id).
    expect(calls[0]!.options?.sessionId).toBe(sessionId)
    expect(calls[0]!.options?.model).toBe("claude-haiku-4-5-20251001")
    expect(calls[0]!.prompt).toBe("reply OK")
  })

  it("resumes the SDK session on the second turn", async () => {
    const calls: Array<{ prompt: unknown; options?: Options }> = []
    const query = fakeQuery([initMsg("sdk-sess-2"), assistantMsg("hi"), resultMsg()], calls)
    const host = new ClaudeSdkAcpAgent(fakeConn([]), {}, query)

    const { sessionId } = await host.newSession({ cwd: "/tmp", mcpServers: [] } as never)
    await host.prompt({ sessionId, prompt: [{ type: "text", text: "a" }] } as never)
    await host.prompt({ sessionId, prompt: [{ type: "text", text: "b" }] } as never)

    expect(calls[0]!.options?.sessionId).toBe(sessionId)
    expect(calls[0]!.options?.resume).toBeUndefined()
    // Second turn resumes the SDK session id adopted from the init message.
    expect(calls[1]!.options?.resume).toBe("sdk-sess-2")
    expect(calls[1]!.options?.sessionId).toBeUndefined()
  })

  it("streams thinking + text deltas live and does not double-emit the completed prose", async () => {
    // Reproduces a long busy turn: the model streams extended-thinking deltas
    // (which, with partials OFF, would surface NOTHING until the turn boundary
    // and leave the daemon ring frozen), then a text delta, then the terminal
    // complete `assistant` message repeating that prose.
    const updates: Array<Record<string, unknown>> = []
    const query = fakeQuery(
      [
        initMsg("sdk-stream-1"),
        thinkingDelta("Answer "),
        thinkingDelta("with PONG."),
        textDelta("PONG"),
        assistantMsg("PONG"), // complete copy of the already-streamed prose
        resultMsg(),
      ],
      [],
    )
    const host = new ClaudeSdkAcpAgent(fakeConn(updates), {}, query)

    const { sessionId } = await host.newSession({ cwd: "/tmp", mcpServers: [] } as never)
    const res = await host.prompt({ sessionId, prompt: [{ type: "text", text: "reply PONG" }] } as never)

    expect(res.stopReason).toBe("end_turn")
    // Thinking surfaced LIVE (was previously dropped entirely) …
    expect(updates.map((u) => u.sessionUpdate)).toEqual([
      "agent_thought_chunk",
      "agent_thought_chunk",
      "agent_message_chunk",
      "usage_update",
    ])
    // … and the prose appears exactly ONCE — streamed via the text delta, then
    // suppressed on the completed assistant message (no double-feed).
    const proseChunks = updates.filter((u) => u.sessionUpdate === "agent_message_chunk")
    expect(proseChunks).toHaveLength(1)
    expect((proseChunks[0]!.content as { text: string }).text).toBe("PONG")
  })

  it("a long thinking stretch keeps the turn alive: streamed deltas reset the idle watchdog", async () => {
    // The reported failure, scaled down: kimi-k2.7-code `--thinking` reasons for
    // longer than the idle window before emitting anything else. With partials
    // OFF that whole span is ONE silent gap and the watchdog wrongly aborts a
    // healthy turn (see the "wedged stream" test). With partials ON, each
    // thinking delta is an SDK message that resets the watchdog, so a thinking
    // span LONGER than idleTimeoutMs still completes.
    const updates: Array<Record<string, unknown>> = []
    const query: QueryFn = () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        yield initMsg("sdk-think-long")
        // 6 × ~15ms = ~90ms of thinking, each gap under the 40ms window but the
        // total span well over it — the exact case that trips a no-partials turn.
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 15))
          yield thinkingDelta(`reasoning step ${i} `)
        }
        yield resultMsg()
      })()
    const host = new ClaudeSdkAcpAgent(fakeConn(updates), { idleTimeoutMs: 40 }, query)

    const { sessionId } = await host.newSession({ cwd: "/tmp", mcpServers: [] } as never)
    const res = await host.prompt({ sessionId, prompt: [{ type: "text", text: "think hard" }] } as never)

    // Completed rather than aborting as a stall …
    expect(res.stopReason).toBe("end_turn")
    // … and every thinking delta reached the ring (no stall error chunk).
    expect(updates.filter((u) => u.sessionUpdate === "agent_thought_chunk")).toHaveLength(6)
    const stall = updates.find(
      (u) =>
        u.sessionUpdate === "agent_message_chunk" &&
        typeof (u.content as { text?: string }).text === "string" &&
        (u.content as { text: string }).text.includes("stalled"),
    )
    expect(stall).toBeUndefined()
  }, 5_000)

  it("surfaces an SDK error as a message chunk + refusal", async () => {
    const updates: Array<Record<string, unknown>> = []
    const query: QueryFn = () =>
      (async function* (): AsyncGenerator<SDKMessage, void> {
        throw new Error("no ANTHROPIC_API_KEY")
      })()
    const host = new ClaudeSdkAcpAgent(fakeConn(updates), {}, query)

    const { sessionId } = await host.newSession({ cwd: "/tmp", mcpServers: [] } as never)
    const res = await host.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] } as never)

    expect(res.stopReason).toBe("refusal")
    expect((updates[0]!.content as { text: string }).text).toContain("claude-sdk error")
  })

  it("fails fast on an unrouted vendor/product model — no query() call, no billed turn", async () => {
    // The dogfooding bug: a gateway model (deepseek/deepseek-v4-flash-0731)
    // spawned with no base_url. Previously this reached query() and, depending
    // on the SDK/gateway, came back as an empty billed turn, a 400 with the
    // wrong model prefix, or — worst — a silent real-Anthropic answer. The
    // guard in buildQueryOptions must reject it BEFORE query() is ever called.
    const updates: Array<Record<string, unknown>> = []
    let queryCalls = 0
    const query: QueryFn = () => {
      queryCalls++
      return (async function* (): AsyncGenerator<SDKMessage> {})()
    }
    const host = new ClaudeSdkAcpAgent(
      fakeConn(updates),
      { model: "deepseek/deepseek-v4-flash-0731" },
      query,
    )

    const { sessionId } = await host.newSession({ cwd: "/tmp", mcpServers: [] } as never)
    const res = await host.prompt({
      sessionId,
      prompt: [{ type: "text", text: "hello" }],
    } as never)

    expect(res.stopReason).toBe("refusal")
    expect(queryCalls).toBe(0)
    expect((updates[0]!.content as { text: string }).text).toContain("claude-sdk error")
    expect((updates[0]!.content as { text: string }).text).toContain(
      "deepseek/deepseek-v4-flash-0731",
    )
  })

  it("keeps the turn alive during a long tool run: pending tool uses a longer watchdog", async () => {
    const updates: Array<Record<string, unknown>> = []
    const query: QueryFn = () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        yield initMsg("sdk-tool-long")
        yield toolUseMsg("tu_1", "some_tool")
        // Tool execution takes longer than the generation watchdog but less than
        // the tool-pending watchdog.
        await new Promise((r) => setTimeout(r, 80))
        yield toolResultMsg("tu_1")
        yield assistantMsg("done")
        yield resultMsg()
      })()
    const host = new ClaudeSdkAcpAgent(fakeConn(updates), { idleTimeoutMs: 40 }, query)

    const { sessionId } = await host.newSession({ cwd: "/tmp", mcpServers: [] } as never)
    const res = await host.prompt({ sessionId, prompt: [{ type: "text", text: "use tool" }] } as never)

    expect(res.stopReason).toBe("end_turn")
    expect(updates.map((u) => u.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
      "usage_update",
    ])
    const stall = updates.find(
      (u) =>
        u.sessionUpdate === "agent_message_chunk" &&
        typeof (u.content as { text?: string }).text === "string" &&
        (u.content as { text: string }).text.includes("stalled"),
    )
    expect(stall).toBeUndefined()
  }, 5_000)
})
