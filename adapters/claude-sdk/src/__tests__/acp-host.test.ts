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
function resultMsg(): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    total_cost_usd: 0.0001,
    usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { "claude-haiku-4-5-20251001": { contextWindow: 200000 } },
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
})
