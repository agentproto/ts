/**
 * The `session_migrate` verb on its two daemon surfaces: the MCP tool and
 * `POST /sessions/:id/migrate`. The orchestration itself is covered in
 * `session-migrate.test.ts`; here: wiring, validation and error mapping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import { registerSessionTools } from "../session-tools.js"
import { setDefaultSessionsBaseDir } from "../transcript-writer.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import { DAEMON_TOOL_NAMES } from "../daemon-tool-names.generated.js"

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

const conversations: ConversationStore = {
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
const heartbeat: HeartbeatRunner = { start() {}, stop() {}, async fireNow() {} }

let counter = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_migrate_${++counter}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

const resolveAgentAdapter: AgentAdapterResolver = async () => ({
  startSession: vi.fn(async () => fakeAgentSession()),
  commandPreview: "mock-adapter",
})

describe("session_migrate wiring", () => {
  it("is a declared daemon tool", () => {
    expect(DAEMON_TOOL_NAMES).toContain("session_migrate")
  })
})

describe("session_migrate over MCP and HTTP", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "migrate-surface-"))
    setDefaultSessionsBaseDir(tmp)
  })
  afterEach(() => {
    setDefaultSessionsBaseDir(undefined)
    rmSync(tmp, { recursive: true, force: true })
  })

  async function boot() {
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "t", version: "0" })).server,
      conversations,
      events: createRuntimeEvents(),
      heartbeat,
      sessions: registry,
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })
    const post = (path: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      })
    const src = await post("/sessions/agent", { adapter: "claude-code", cwd: tmp })
    expect(src.status).toBe(201)
    const source = (await src.json()) as SessionDescriptor
    return { registry, post, source, stop: async () => (await http.stop(), registry.shutdown()) }
  }

  async function mcpClient(registry: ReturnType<typeof createSessionsRegistry>, withResolver: boolean) {
    const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
    registerSessionTools(server, {
      registry,
      workspace: tmp,
      ...(withResolver ? { resolveAgentAdapter } : {}),
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test-client", version: "0" })
    await client.connect(clientTransport)
    return client
  }

  const payload = (r: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> =>
    JSON.parse((r.content as Array<{ text: string }>)[0]?.text ?? "{}")

  it("HTTP: 404 unknown session, 400 on a malformed body, 400 not_sandbox_session on a local session", async () => {
    const h = await boot()
    try {
      expect((await h.post("/sessions/sess_nope/migrate")).status).toBe(404)
      const bad = await h.post(`/sessions/${h.source.id}/migrate`, { sandbox: 3 })
      expect(bad.status).toBe(400)
      expect(((await bad.json()) as { error: string }).error).toBe("invalid_sandbox")

      const res = await h.post(`/sessions/${h.source.id}/migrate`, { sandbox: "e2b" })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string; message: string }
      expect(body.error).toBe("not_sandbox_session")
      expect(body.message).toMatch(/does not run in a sandbox/)
      // The refused migration left the session alone.
      expect(h.registry.get(h.source.id)?.continuedTo).toBeUndefined()
    } finally {
      await h.stop()
    }
  })

  it("MCP: is listed, reports no_such_session and not_sandbox_session with a code", async () => {
    const h = await boot()
    const client = await mcpClient(h.registry, true)
    try {
      const tools = await client.listTools()
      const tool = tools.tools.find(t => t.name === "session_migrate")
      expect(tool).toBeDefined()
      expect(Object.keys((tool?.inputSchema.properties ?? {}) as object).sort()).toEqual([
        "idOrName",
        "model",
        "profile",
        "sandbox",
        "sessionId",
        "slug",
      ])

      const missing = await client.callTool({ name: "session_migrate", arguments: { sessionId: "sess_nope" } })
      expect(missing.isError).toBe(true)
      expect(payload(missing).code).toBe("no_such_session")

      const local = await client.callTool({ name: "session_migrate", arguments: { sessionId: h.source.id } })
      expect(local.isError).toBe(true)
      expect(payload(local).code).toBe("not_sandbox_session")
    } finally {
      await client.close()
      await h.stop()
    }
  })

  it("MCP: refuses without an adapter resolver", async () => {
    const h = await boot()
    const client = await mcpClient(h.registry, false)
    try {
      const r = await client.callTool({ name: "session_migrate", arguments: { sessionId: h.source.id } })
      expect(r.isError).toBe(true)
      expect(String(payload(r).error)).toMatch(/adapter resolver/)
    } finally {
      await client.close()
      await h.stop()
    }
  })
})
