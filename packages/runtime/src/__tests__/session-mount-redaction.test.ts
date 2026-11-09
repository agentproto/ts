/**
 * Mount secrets on a session descriptor (`mcpServers[].env` / `.headers`, an
 * `/mcp/orchestrator` scope-token in `ref`) must never cross the MCP tool or
 * HTTP boundary, while the registry keeps the real values so restart and
 * continue-fresh can re-mount the same servers.
 */

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { buildAgentStartResponseBody } from "../agent-tools.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const ENV_CANARY = "synthetic-mount-env-canary-not-a-credential"
const HEADER_CANARY = "synthetic-mount-header-canary-not-a-credential"
const SCOPE_CANARY = "synthetic-scope-canary-not-a-credential"

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "mount-redaction-agent",
    availableModes: [],
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function spawnWithMounts(registry: ReturnType<typeof createSessionsRegistry>) {
  return registry.spawnAgent({
    workspaceSlug: "default",
    cwd: process.cwd(),
    adapterSlug: "claude-code",
    agentSession: fakeAgentSession(),
    mcpServers: [
      { name: "local", transport: "stdio", ref: "local-mcp", env: { LOCAL_TOKEN: ENV_CANARY } },
      {
        name: "remote",
        transport: "http",
        ref: "https://mcp.example.test/mcp",
        headers: { Authorization: `Bearer ${HEADER_CANARY}` },
      },
      {
        name: "orchestrator",
        transport: "http",
        ref: `http://127.0.0.1:1/mcp/orchestrator?scope=${SCOPE_CANARY}`,
      },
    ],
  })
}

function expectRedacted(text: string, id: string, rows?: Array<Record<string, unknown>>): void {
  expect(text).not.toContain(ENV_CANARY)
  expect(text).not.toContain(HEADER_CANARY)
  expect(text).not.toContain(SCOPE_CANARY)
  const row = rows ? rows.find(r => r.id === id) : (JSON.parse(text) as Record<string, unknown>)
  const servers = row?.mcpServers as Array<Record<string, unknown>>
  expect(servers.map(s => s.name)).toEqual(["local", "remote", "orchestrator"])
  expect(servers[0]?.env).toEqual({ LOCAL_TOKEN: "[redacted]" })
  expect(servers[1]?.headers).toEqual({ Authorization: "[redacted]" })
}

function expectCapabilitiesRedacted(text: string): void {
  expect(text).not.toContain(ENV_CANARY)
  expect(text).not.toContain(HEADER_CANARY)
  expect(text).not.toContain(SCOPE_CANARY)
  const caps = JSON.parse(text) as { mcpServers: Array<{ name: string; ref?: string }> }
  expect(caps.mcpServers.map(s => s.name)).toEqual(["local", "remote", "orchestrator"])
  expect(caps.mcpServers[2]?.ref).not.toContain(SCOPE_CANARY)
}

function expectStoredIntact(registry: ReturnType<typeof createSessionsRegistry>, id: string): void {
  const stored = registry.get(id)?.mcpServers
  expect(stored?.[0]?.env).toEqual({ LOCAL_TOKEN: ENV_CANARY })
  expect(stored?.[1]?.headers).toEqual({ Authorization: `Bearer ${HEADER_CANARY}` })
  expect(stored?.[2]?.ref).toContain(SCOPE_CANARY)
}

function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content
  return content?.[0]?.text ?? ""
}

describe("session descriptor mount redaction", () => {
  it("MCP: session_list / session_search / agent_sessions_list full rows redact mount secrets", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const server = new McpServer({ name: "mount-redaction-test", version: "0" })
    registerSessionTools(server, { registry, workspace: process.cwd() })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "mount-redaction-test-client", version: "0" })
    await client.connect(clientTransport)
    try {
      const desc = spawnWithMounts(registry)
      for (const [name, args] of [
        ["session_list", { full: true }],
        ["session_search", { query: "", full: true }],
        ["agent_sessions_list", { full: true }],
      ] as const) {
        const text = firstText(await client.callTool({ name, arguments: args }))
        const page = JSON.parse(text) as { sessions: Array<Record<string, unknown>> }
        expectRedacted(text, desc.id, page.sessions)
      }
      const capabilitiesText = firstText(
        await client.callTool({ name: "session_capabilities", arguments: { sessionId: desc.id } }),
      )
      expectCapabilitiesRedacted(capabilitiesText)
      expectStoredIntact(registry, desc.id)
    } finally {
      await client.close()
      registry.shutdown()
    }
  })

  it("agent_start: the full:true and fields:[mcpServers] bodies redact mount secrets", () => {
    const registry = createSessionsRegistry({ persist: false })
    try {
      const desc = spawnWithMounts(registry)
      expectRedacted(JSON.stringify(buildAgentStartResponseBody(desc, {}, { full: true })), desc.id)
      expectRedacted(JSON.stringify(buildAgentStartResponseBody(desc, {}, { fields: ["mcpServers"] })), desc.id)
      expectStoredIntact(registry, desc.id)
    } finally {
      registry.shutdown()
    }
  })

  it("HTTP: GET /sessions and GET /sessions/:id redact mount secrets", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const desc = spawnWithMounts(registry)
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer()
      probe.once("error", reject)
      probe.listen(0, "127.0.0.1", () => {
        const p = (probe.address() as AddressInfo).port
        probe.close(() => resolve(p))
      })
    })
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
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "mount-redaction-http", version: "0" })).server,
      conversations,
      events: createRuntimeEvents(),
      heartbeat,
      sessions: registry,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const listText = await (await fetch(`http://127.0.0.1:${port}/sessions`)).text()
      expectRedacted(listText, desc.id, (JSON.parse(listText) as { sessions: Array<Record<string, unknown>> }).sessions)
      const detailText = await (await fetch(`http://127.0.0.1:${port}/sessions/${desc.id}`)).text()
      expectRedacted(detailText, desc.id)
      const capabilitiesText = await (await fetch(`http://127.0.0.1:${port}/sessions/${desc.id}/capabilities`)).text()
      expectCapabilitiesRedacted(capabilitiesText)
      expectStoredIntact(registry, desc.id)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })
})
