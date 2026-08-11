import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { AgentControllerEvent } from "@mastra/core/agent-controller"
import { describe, expect, it } from "vitest"
import {
  MastraAcpAgent,
  type ControllerLike,
  type ControllerSessionLike,
} from "../acp-host.js"

/** Capture the `update` payloads the host pushes via sessionUpdate. */
function fakeConn(sink: unknown[]): AgentSideConnection {
  return {
    sessionUpdate: async (p: { update: unknown }) => {
      sink.push(p.update)
    },
  } as unknown as AgentSideConnection
}

/** A minimal assistant message for scripted `message_update` events. */
function assistantMessage(id: string, text: string) {
  return {
    id,
    role: "assistant",
    createdAt: new Date(0),
    content: { format: 2, parts: [{ type: "text", text }] },
  } as Extract<AgentControllerEvent, { type: "message_update" }>["message"]
}

/**
 * A controller session that replays a scripted event sequence to its
 * subscribers when `sendMessage` runs (as the real run engine does), then
 * lets `sendMessage` resolve — mirroring "resolves on agent_end".
 */
function scriptedSession(events: AgentControllerEvent[]): ControllerSessionLike & {
  aborted: boolean
} {
  const listeners = new Set<(event: AgentControllerEvent) => void | Promise<void>>()
  return {
    aborted: false,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async sendMessage() {
      for (const event of events) {
        for (const listener of listeners) void listener(event)
      }
    },
    abort() {
      this.aborted = true
    },
  }
}

function controllerOf(
  session: ControllerSessionLike,
  createSessionCalls: unknown[] = [],
): ControllerLike {
  return {
    init: async () => {},
    createSession: async (opts) => {
      createSessionCalls.push(opts)
      return session
    },
  }
}

describe("MastraAcpAgent — controller event relay", () => {
  it("forwards text deltas + tool_call + tool_call_update to the client", async () => {
    const updates: Array<Record<string, unknown>> = []
    const session = scriptedSession([
      { type: "agent_start" },
      { type: "message_update", message: assistantMessage("m1", "let me run that") },
      {
        type: "tool_start",
        toolCallId: "tc1",
        toolName: "run_command",
        args: { command: "ls" },
      },
      {
        type: "tool_end",
        toolCallId: "tc1",
        result: { stdout: "a\nb", exitCode: 0 },
        isError: false,
      },
      { type: "message_update", message: assistantMessage("m1", "let me run thatdone") },
      { type: "agent_end", reason: "complete" },
    ])
    const host = new MastraAcpAgent(fakeConn(updates), async () => ({
      controller: controllerOf(session),
    }))

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
    expect((updates[0]!.content as { text: string }).text).toBe("let me run that")
    expect(updates[1]).toMatchObject({
      toolCallId: "tc1",
      kind: "execute",
      status: "in_progress",
    })
    expect(updates[2]).toMatchObject({ toolCallId: "tc1", status: "completed" })
    expect((updates[3]!.content as { text: string }).text).toBe("done")
  })

  it("creates the controller session keyed to the ACP session (thread + scope)", async () => {
    const calls: unknown[] = []
    const session = scriptedSession([{ type: "agent_end", reason: "complete" }])
    const host = new MastraAcpAgent(fakeConn([]), async () => ({
      controller: controllerOf(session, calls),
    }))

    const { sessionId } = await host.newSession({} as never)
    await host.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] } as never)
    await host.prompt({ sessionId, prompt: [{ type: "text", text: "again" }] } as never)

    // One controller session per ACP session, created on the first prompt.
    expect(calls).toEqual([
      { resourceId: "mastra-agent", scope: sessionId, threadId: sessionId },
    ])
  })

  it("surfaces a run that ends in error as an error chunk + refusal", async () => {
    const updates: Array<Record<string, unknown>> = []
    const session = scriptedSession([
      { type: "error", error: new Error("model exploded") },
      { type: "agent_end", reason: "error" },
    ])
    const host = new MastraAcpAgent(fakeConn(updates), async () => ({
      controller: controllerOf(session),
    }))

    const { sessionId } = await host.newSession({} as never)
    const res = await host.prompt({
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never)

    expect(res.stopReason).toBe("refusal")
    expect(updates).toHaveLength(1)
    expect((updates[0]!.content as { text: string }).text).toContain(
      "[mastra-agent error] model exploded",
    )
  })

  it("surfaces a controller build failure as an error chunk + refusal", async () => {
    const updates: Array<Record<string, unknown>> = []
    const host = new MastraAcpAgent(fakeConn(updates), async () => {
      throw new Error("no API key")
    })

    const { sessionId } = await host.newSession({} as never)
    const res = await host.prompt({
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never)

    expect(res.stopReason).toBe("refusal")
    expect((updates[0]!.content as { text: string }).text).toContain(
      "[mastra-agent error] no API key",
    )
  })

  it("reports an aborted run as cancelled", async () => {
    const session = scriptedSession([
      { type: "message_update", message: assistantMessage("m1", "partial") },
      { type: "agent_end", reason: "aborted" },
    ])
    const host = new MastraAcpAgent(fakeConn([]), async () => ({
      controller: controllerOf(session),
    }))

    const { sessionId } = await host.newSession({} as never)
    const res = await host.prompt({
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never)
    expect(res.stopReason).toBe("cancelled")
  })

  it("cancel aborts the live controller session", async () => {
    const session = scriptedSession([{ type: "agent_end", reason: "complete" }])
    const host = new MastraAcpAgent(fakeConn([]), async () => ({
      controller: controllerOf(session),
    }))

    const { sessionId } = await host.newSession({} as never)
    await host.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] } as never)
    await host.cancel({ sessionId } as never)
    expect(session.aborted).toBe(true)
  })

  it("rejects prompts for unknown sessions", async () => {
    const host = new MastraAcpAgent(fakeConn([]), async () => ({
      controller: controllerOf(scriptedSession([])),
    }))
    await expect(
      host.prompt({ sessionId: "nope", prompt: [] } as never),
    ).rejects.toThrow(/unknown session/)
  })
})
