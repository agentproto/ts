/**
 * `interruptSession` — the bare "interrupt, no next prompt" primitive
 * `sendPrompt`/`enqueuePrompt`'s `opts.interrupt` arm lacks on its own
 * (that arm always exists to redirect onto a NEW prompt). Reuses the
 * same `interruptInFlightTurn` helper those two share — see
 * `prompt-interrupt.test.ts` for that helper's own settle-timing tests;
 * this file only covers the new entry points layered on top of it:
 * the registry method, `POST /sessions/:id/interrupt`, and the MCP
 * `agent_interrupt` verb.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { startHttpServer } from "../http-server.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { registerAgentTools } from "../agent-tools.js"
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

async function mcpServerFactory() {
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

/** Mirrors `prompt-interrupt.test.ts`'s fixture: `cancel()` resolves a
 *  couple of microtask ticks after being called, and the turn doesn't
 *  end until then either — proves the caller awaits the real settle. */
function interruptibleAgentSession(): AgentSessionLike {
  let releaseFirstTurn!: () => void
  const gate = new Promise<void>(resolve => {
    releaseFirstTurn = resolve
  })
  return {
    sessionId: "interruptible-session",
    async *send() {
      await gate
      yield { kind: "turn-end", reason: "cancelled" }
    },
    async cancel() {
      await Promise.resolve()
      await Promise.resolve()
      releaseFirstTurn()
    },
    async close() {},
  }
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

function uncancelableAgentSession(): AgentSessionLike {
  return {
    sessionId: "uncancelable-session",
    async *send() {
      await new Promise<void>(() => {
        // hangs forever — this session is never actually cancelled
      })
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {
      throw new Error("adapter does not implement session/cancel")
    },
    async close() {},
  }
}

describe("interruptSession — registry", () => {
  it("is a no-op on an idle session", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })

    await expect(reg.interruptSession(desc.id)).resolves.toEqual({ wasBusy: false })
    expect(reg.get(desc.id)?.status).toBe("running")
    reg.shutdown()
  })

  it("mid-turn: cancels the in-flight turn, awaits it settling, then resolves wasBusy:true", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: interruptibleAgentSession(),
      adapterSlug: "fake",
    })

    const firstPromise = reg.sendPrompt(desc.id, "first")
    await Promise.resolve()
    expect(reg.get(desc.id)?.busy).toBe(true)

    await expect(reg.interruptSession(desc.id)).resolves.toEqual({ wasBusy: true })

    // Cancelled, not killed — the session is still alive and idle.
    expect(reg.get(desc.id)?.status).toBe("running")
    expect(reg.get(desc.id)?.busy).toBe(false)

    await expect(firstPromise).resolves.toBeUndefined()
    reg.shutdown()
  })

  it("is a no-op on a terminal (killed) session", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    reg.kill(desc.id)

    await expect(reg.interruptSession(desc.id)).resolves.toEqual({ wasBusy: false })
    reg.shutdown()
  })

  it("throws for an unknown session id", async () => {
    const reg = createSessionsRegistry({ persist: false })
    await expect(reg.interruptSession("nope")).rejects.toThrow(/no session "nope"/)
    reg.shutdown()
  })

  it("propagates the adapter's cancel() rejection as a clear error", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: uncancelableAgentSession(),
      adapterSlug: "fake",
    })

    void reg.sendPrompt(desc.id, "first")
    await Promise.resolve()
    expect(reg.get(desc.id)?.busy).toBe(true)

    await expect(reg.interruptSession(desc.id)).rejects.toThrow(/does not support interrupt/)

    // The first turn is untouched — still mid-turn, session still alive.
    expect(reg.get(desc.id)?.busy).toBe(true)
    expect(reg.get(desc.id)?.status).toBe("running")
    reg.kill(desc.id)
    reg.shutdown()
  })
})

describe("POST /sessions/:id/interrupt — HTTP route", () => {
  it("200 shape on idle and mid-turn sessions, 404 on unknown, 409 on unsupported", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const idle = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: instantAgentSession(),
        adapterSlug: "fake",
      })
      const idleRes = await fetch(`http://127.0.0.1:${port}/sessions/${idle.id}/interrupt`, {
        method: "POST",
      })
      expect(idleRes.status).toBe(200)
      expect(await idleRes.json()).toEqual({ ok: true, id: idle.id, wasBusy: false })

      const busy = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: interruptibleAgentSession(),
        adapterSlug: "fake",
      })
      const firstPromise = registry.sendPrompt(busy.id, "first")
      await Promise.resolve()
      const busyRes = await fetch(`http://127.0.0.1:${port}/sessions/${busy.id}/interrupt`, {
        method: "POST",
      })
      expect(busyRes.status).toBe(200)
      expect(await busyRes.json()).toEqual({ ok: true, id: busy.id, wasBusy: true })
      await expect(firstPromise).resolves.toBeUndefined()

      const unknownRes = await fetch(`http://127.0.0.1:${port}/sessions/nope/interrupt`, {
        method: "POST",
      })
      expect(unknownRes.status).toBe(404)

      const uncancelable = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: uncancelableAgentSession(),
        adapterSlug: "fake",
      })
      void registry.sendPrompt(uncancelable.id, "first")
      await Promise.resolve()
      const unsupportedRes = await fetch(
        `http://127.0.0.1:${port}/sessions/${uncancelable.id}/interrupt`,
        { method: "POST" },
      )
      expect(unsupportedRes.status).toBe(409)
      registry.kill(uncancelable.id)
    } finally {
      await http.stop()
    }
  })

  it("auth gate parity with POST /sessions/:id/prompt", async () => {
    const TOKEN = "test-secret-token"
    const registry = createSessionsRegistry({ persist: false })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      token: TOKEN,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const noAuth = await fetch(`http://127.0.0.1:${port}/sessions/nope/interrupt`, {
        method: "POST",
      })
      expect(noAuth.status).toBe(401)

      const withToken = await fetch(`http://127.0.0.1:${port}/sessions/nope/interrupt`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      // Past the auth gate — the (nonexistent) session then 404s.
      expect(withToken.status).toBe(404)
    } finally {
      await http.stop()
    }
  })
})

describe("agent_interrupt (MCP)", () => {
  it("cancels a mid-turn session and leaves it alive and idle", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: interruptibleAgentSession(),
      adapterSlug: "fake",
    })

    const server = new McpServer({ name: "agent-interrupt-server", version: "0.0.0" })
    registerAgentTools(server, { registry })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "agent-interrupt-client", version: "0.0.0" })
    await client.connect(clientTransport)

    const firstPromise = registry.sendPrompt(desc.id, "first")
    await Promise.resolve()
    expect(registry.get(desc.id)?.busy).toBe(true)

    const result = (await client.callTool({
      name: "agent_interrupt",
      arguments: { sessionId: desc.id },
    })) as { isError?: boolean; content: Array<{ type: "text"; text: string }> }
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      ok: true,
      sessionId: desc.id,
      wasBusy: true,
    })
    expect(registry.get(desc.id)?.status).toBe("running")

    await expect(firstPromise).resolves.toBeUndefined()
    registry.shutdown()
  })

  it("errors with missingSessionIdError when no session id is given", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const server = new McpServer({ name: "agent-interrupt-server-2", version: "0.0.0" })
    registerAgentTools(server, { registry })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "agent-interrupt-client-2", version: "0.0.0" })
    await client.connect(clientTransport)

    const result = (await client.callTool({
      name: "agent_interrupt",
      arguments: {},
    })) as { isError?: boolean }
    expect(result.isError).toBe(true)
    registry.shutdown()
  })
})
