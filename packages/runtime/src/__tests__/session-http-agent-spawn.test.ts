/**
 * HTTP-level parity test for `POST /sessions/agent` (http-server.ts)
 * against the MCP `agent_start` tool (agent-tools.ts) — both now
 * delegate to the same `spawnAgentSession` (session-spawn.ts). Closes
 * the exact gap PR #158 found: the HTTP route used to silently drop
 * `orchestrator`/`mcpServers`, so a hermes/mastracode child spawned via
 * HTTP never got the mcpServers the MCP path gave it.
 */

import { describe, it, expect, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"
import type { AcpMcpServer } from "@agentproto/acp"

import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createOrchestratorInjector, createScopeTokenRegistry } from "../orchestrator-gateway.js"
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
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_http_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

async function mcpServerFactory() {
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

describe("POST /sessions/agent — orchestrator/mcpServers parity with agent_start (MCP)", () => {
  it("orchestrator:true + caller mcpServers → descriptor carries BOTH entries", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
    })
    const sessionEvents = createSessionEventBus()
    const scopeTokens = createScopeTokenRegistry()
    const port = await freePort()
    const buildOrchestratorMcp = createOrchestratorInjector({
      scopeTokens,
      sessionEvents,
      port,
    })

    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      resolveAgentAdapter,
      buildOrchestratorMcp,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const callerEntry: AcpMcpServer = {
        name: "custom",
        transport: "http",
        ref: "http://example.test/mcp",
      }
      const res = await fetch(`http://127.0.0.1:${port}/sessions/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          adapter: "mock",
          cwd: "/tmp",
          orchestrator: true,
          mcpServers: [callerEntry],
        }),
      })
      expect(res.status).toBe(201)
      const desc = (await res.json()) as SessionDescriptor
      expect(desc.mcpServers).toHaveLength(2)
      expect(desc.mcpServers).toContainEqual(callerEntry)
      const orchestratorEntry = desc.mcpServers?.find(s => s.name === "agentproto")
      expect(orchestratorEntry).toBeDefined()
      expect(orchestratorEntry?.ref).toContain("/mcp/orchestrator?scope=")

      // Same shape as the MCP path: the adapter itself was started with
      // both entries merged into one mcpServers array.
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: expect.arrayContaining([
            callerEntry,
            expect.objectContaining({ name: "agentproto" }),
          ]),
        }),
      )
    } finally {
      await http.stop()
    }
  })

  it("orchestrator:true with no buildOrchestratorMcp wired → 501 not-enabled", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
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
      // no buildOrchestratorMcp — daemon started without the sub-gateway.
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapter: "mock", cwd: "/tmp", orchestrator: true }),
      })
      expect(res.status).toBe(501)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("orchestrator_not_enabled")
      expect(startSession).not.toHaveBeenCalled()
      expect(registry.list()).toHaveLength(0)
    } finally {
      await http.stop()
    }
  })
})
