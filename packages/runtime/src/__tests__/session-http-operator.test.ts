/**
 * AIP-46 §Operator binding on `POST /sessions/agent`: the HTTP twin of the MCP
 * `agent_start` tool, both delegating to `spawnAgentSession`. Same record,
 * same refusals, mapped to HTTP statuses.
 */

import { describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { buildSpawnSessionHttpArgs, startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
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

const noopConversations = (): ConversationStore => ({
  async open() {},
  async appendTurn() {},
  async read() {
    return { meta: {} as never, turns: [] }
  },
  async list() {
    return []
  },
  pathFor: (id: string) => id,
})

const noopHeartbeat = (): HeartbeatRunner => ({ start() {}, stop() {}, async fireNow() {} })

const fakeSession = (): AgentSessionLike => ({
  sessionId: "acp_http_operator_test",
  // eslint-disable-next-line require-yield
  async *send() {},
  async cancel() {},
  async close() {},
})

async function startServer() {
  const registry = createSessionsRegistry({ persist: false })
  const startSession = vi.fn(async () => fakeSession())
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession,
    commandPreview: "mock-adapter",
  })
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    sessions: registry,
    resolveAgentAdapter,
    meta: { workspace: process.cwd(), registered: [] },
  })
  const spawn = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/sessions/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ adapter: "mock", cwd: "/tmp", ...body }),
    })
  return { registry, http, spawn, startSession }
}

describe("POST /sessions/agent: operator binding (HTTP twin of agent_start)", () => {
  it("forwards operator and operatorDigest to the spawn input", () => {
    const args = buildSpawnSessionHttpArgs(
      { operator: "operator:cto", operatorDigest: "sha256:aaa" },
      "opencode",
    )
    expect(args).toMatchObject({ operator: "operator:cto", operatorDigest: "sha256:aaa" })
    expect("operator" in buildSpawnSessionHttpArgs({}, "opencode")).toBe(false)
  })

  it("records operator and operatorDigest on the descriptor", async () => {
    const { registry, http, spawn } = await startServer()
    try {
      const res = await spawn({ operator: "ws://operators/cto", operatorDigest: "sha256:aaa" })
      expect(res.status).toBe(201)
      const body = (await res.json()) as { id: string }
      expect(registry.get(body.id)).toMatchObject({ operator: "operator:cto", operatorDigest: "sha256:aaa" })
    } finally {
      await http.stop()
    }
  })

  it("refuses a malformed ref with 400 operator_unresolvable and starts nothing", async () => {
    const { registry, http, spawn, startSession } = await startServer()
    try {
      const res = await spawn({ operator: "cto" })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: "operator_unresolvable" })
      expect(startSession).not.toHaveBeenCalled()
      expect(registry.list()).toHaveLength(0)
    } finally {
      await http.stop()
    }
  })

  it("refuses with 403 delegation_denied a session caller naming another operator", async () => {
    const { registry, http, spawn, startSession } = await startServer()
    try {
      const caller = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeSession(),
        adapterSlug: "mock",
        operator: "operator:cto",
      })
      const res = await spawn({ operator: "operator:cfo" }, { "x-agentproto-caller-session-id": caller.id })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: "delegation_denied" })
      expect(startSession).not.toHaveBeenCalled()
    } finally {
      await http.stop()
    }
  })

  it("lets a session caller name its own operator and starts a nested spawn that names none without one", async () => {
    const { registry, http, spawn } = await startServer()
    try {
      const caller = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeSession(),
        adapterSlug: "mock",
        operator: "operator:cto",
      })
      const headers = { "x-agentproto-caller-session-id": caller.id }
      const own = await spawn({ operator: "operator:cto" }, headers)
      expect(own.status).toBe(201)
      expect(registry.get(((await own.json()) as { id: string }).id)?.operator).toBe("operator:cto")
      const none = await spawn({}, headers)
      expect(none.status).toBe(201)
      expect(registry.get(((await none.json()) as { id: string }).id)?.operator).toBeUndefined()
    } finally {
      await http.stop()
    }
  })
})
