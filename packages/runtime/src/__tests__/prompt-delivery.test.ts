/**
 * Prompt-delivery reliability — two bugs observed live on real
 * sessions, both rooted in the same shape: an ingress path reported
 * `{ok: true, queued: true}` (or a 2xx) without actually confirming the
 * prompt would be dispatched.
 *
 *   1. Dead session (killed/exited/error) — MCP `agent_prompt` fired
 *      `sendPrompt` without awaiting it, so a dead/unresumable session
 *      always looked like success even though the prompt went nowhere.
 *   2. Busy session — the same fire-and-forget swallowed the "mid-turn"
 *      busy rejection, so a second prompt racing an in-flight turn
 *      silently vanished instead of erroring.
 *
 * The fix: both `agent_prompt` (MCP) and `POST /sessions/:id/prompt`
 * (`?wait=false`, HTTP) now await `enqueuePrompt`'s admission phase
 * (resume attempt + liveness/kind/busy checks) before reporting
 * success — only the turn's own execution stays fire-and-forget. A
 * dead session throws `SessionNotAliveError` (structured: carries the
 * actual `status`); a busy session throws the existing "mid-turn"
 * error. Neither is swallowed anymore.
 */

import { describe, it, expect, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import {
  createSessionsRegistry,
  SessionNotAliveError,
  type AgentSessionLike,
} from "../sessions.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return { start() {}, stop() {}, async fireNow() {} }
}

/** A fake agent-cli session whose `send()` hangs until `release()` is
 *  called — models a turn that's still in flight. */
function hangingAgentSession(): {
  agent: AgentSessionLike
  release: () => void
} {
  let release!: () => void
  const gate = new Promise<void>(res => {
    release = res
  })
  const agent: AgentSessionLike = {
    sessionId: "hanging-session",
    async *send() {
      await gate
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
  return { agent, release }
}

function instantAgentSession(): AgentSessionLike {
  return {
    sessionId: "instant-session",
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

async function mcpServerFactory() {
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

describe("prompt delivery — dead session (bug 1)", () => {
  it("registry: sendPrompt/enqueuePrompt reject a killed session with SessionNotAliveError instead of dispatching", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    reg.kill(desc.id)
    expect(reg.get(desc.id)?.status).toBe("killed")

    await expect(reg.sendPrompt(desc.id, "hello")).rejects.toThrow(SessionNotAliveError)
    await expect(reg.enqueuePrompt(desc.id, "hello")).rejects.toThrow(SessionNotAliveError)

    try {
      await reg.sendPrompt(desc.id, "hello")
      expect.fail("expected sendPrompt to reject")
    } catch (err) {
      expect(err).toBeInstanceOf(SessionNotAliveError)
      expect((err as SessionNotAliveError).status).toBe("killed")
    }
    reg.shutdown()
  })

  it("MCP agent_prompt: dead session surfaces as a structured tool error, not {queued: true}", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    registry.kill(desc.id)

    const server = new McpServer({ name: "prompt-delivery-server", version: "0.0.0" })
    registerAgentTools(server, { registry })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "prompt-delivery-client", version: "0.0.0" })
    await client.connect(clientTransport)

    const res = (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "hello?" },
    })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> }

    expect(res.isError).toBe(true)
    expect(res.content?.[0]?.text).toContain("not alive")
    expect(res.content?.[0]?.text).toContain("killed")
    registry.shutdown()
  })

  it("HTTP POST /sessions/:id/prompt: dead session → 409 {error: session_not_alive, status}, both wait modes", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    registry.kill(desc.id)

    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession: vi.fn(),
      commandPreview: "mock-adapter",
    })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const waitRes = await fetch(`http://127.0.0.1:${port}/sessions/${desc.id}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hello" }),
      })
      expect(waitRes.status).toBe(409)
      const waitBody = (await waitRes.json()) as { error: string; status: string }
      expect(waitBody).toEqual({ error: "session_not_alive", status: "killed" })

      const fireRes = await fetch(
        `http://127.0.0.1:${port}/sessions/${desc.id}/prompt?wait=false`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "hello" }),
        },
      )
      expect(fireRes.status).toBe(409)
      const fireBody = (await fireRes.json()) as { error: string; status: string }
      expect(fireBody).toEqual({ error: "session_not_alive", status: "killed" })
    } finally {
      await http.stop()
    }
    registry.shutdown()
  })
})

describe("prompt delivery — busy session (bug 2)", () => {
  it("registry: two prompts racing a busy session — second rejects with a busy error, neither is silently dropped", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const { agent, release } = hangingAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    // `first` is a real in-flight turn (its promise won't resolve until
    // `release()` fires below) — don't await it before racing `second`
    // against it, or this test would hang on its own fixture.
    const firstPromise = reg.sendPrompt(desc.id, "first")
    const secondPromise = reg.enqueuePrompt(desc.id, "second")

    // The racing prompt is rejected loudly (busy) — never silently
    // dropped, never silently accepted alongside the in-flight turn.
    await expect(secondPromise).rejects.toThrow(/mid-turn/)

    release()
    await expect(firstPromise).resolves.toBeUndefined()
    reg.shutdown()
  })

  it("MCP agent_prompt: a prompt sent during an active turn gets a loud busy error, not a silent drop", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, release } = hangingAgentSession()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    const server = new McpServer({ name: "prompt-delivery-busy-server", version: "0.0.0" })
    registerAgentTools(server, { registry })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "prompt-delivery-busy-client", version: "0.0.0" })
    await client.connect(clientTransport)

    const first = (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "first" },
    })) as { isError?: boolean }
    expect(first.isError).toBeUndefined()
    expect(registry.get(desc.id)?.busy).toBe(true)

    const second = (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "second (sent via HTTP arm in the real repro)" },
    })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
    expect(second.isError).toBe(true)
    expect(second.content?.[0]?.text).toContain("mid-turn")

    release()
    await new Promise(res => setTimeout(res, 10))
    registry.shutdown()
  })

  it("HTTP POST /sessions/:id/prompt: second prompt on a busy session → 409, first still dispatched", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, release } = hangingAgentSession()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })

    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession: vi.fn(),
      commandPreview: "mock-adapter",
    })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const firstRes = await fetch(
        `http://127.0.0.1:${port}/sessions/${desc.id}/prompt?wait=false`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "first" }),
        },
      )
      expect(firstRes.status).toBe(202)
      expect(registry.get(desc.id)?.busy).toBe(true)

      const secondRes = await fetch(`http://127.0.0.1:${port}/sessions/${desc.id}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "second" }),
      })
      expect(secondRes.status).toBe(409)
      const secondBody = (await secondRes.json()) as { error: string; message: string }
      expect(secondBody.error).toBe("send_prompt_failed")
      expect(secondBody.message).toContain("mid-turn")

      release()
      await new Promise(res => setTimeout(res, 10))
    } finally {
      await http.stop()
    }
    registry.shutdown()
  })
})
