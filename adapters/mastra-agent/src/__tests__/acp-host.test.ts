import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import { describe, expect, it } from "vitest"
import { MastraAcpAgent, type MastraLike } from "../acp-host.js"
import type { MastraStreamChunk } from "../tool-call-map.js"

/** A ReadableStream that yields the given chunks then closes. */
function streamOf<T>(chunks: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
}

/** Capture the `update` payloads the host pushes via sessionUpdate. */
function fakeConn(sink: unknown[]): AgentSideConnection {
  return {
    sessionUpdate: async (p: { update: unknown }) => {
      sink.push(p.update)
    },
  } as unknown as AgentSideConnection
}

describe("MastraAcpAgent — fullStream relay", () => {
  it("forwards text + tool_call + tool_call_update to the client", async () => {
    const updates: Array<Record<string, unknown>> = []
    const chunks: MastraStreamChunk[] = [
      { type: "text-delta", payload: { text: "let me run that" } },
      {
        type: "tool-call",
        payload: { toolCallId: "tc1", toolName: "run_command", args: { command: "ls" } },
      },
      {
        type: "tool-result",
        payload: { toolCallId: "tc1", result: { stdout: "a\nb", exitCode: 0 } },
      },
      { type: "text-delta", payload: { text: "done" } },
    ]
    const agent: MastraLike = {
      stream: async () => ({ fullStream: streamOf(chunks) }),
    }
    const host = new MastraAcpAgent(fakeConn(updates), async () => agent)

    const { sessionId } = await host.newSession({} as never)
    const res = await host.prompt({
      sessionId,
      prompt: [{ type: "text", text: "list files" }],
    } as never)

    expect(res.stopReason).toBe("end_turn")
    expect(updates.map((u) => u.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
    ])
    expect(updates[1]).toMatchObject({
      toolCallId: "tc1",
      kind: "execute",
      status: "in_progress",
    })
    expect(updates[2]).toMatchObject({ toolCallId: "tc1", status: "completed" })
  })

  it("falls back to textStream when fullStream is absent", async () => {
    const updates: Array<Record<string, unknown>> = []
    const agent: MastraLike = {
      stream: async () => ({ textStream: streamOf(["hello ", "world"]) }),
    }
    const host = new MastraAcpAgent(fakeConn(updates), async () => agent)

    const { sessionId } = await host.newSession({} as never)
    await host.prompt({
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never)

    expect(updates.map((u) => u.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "agent_message_chunk",
    ])
    expect(updates.map((u) => (u.content as { text: string }).text).join("")).toBe(
      "hello world",
    )
  })
})
