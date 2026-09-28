/**
 * `/mcp/imported/<id>` — the per-import MCP passthrough (PLAN D phase 1):
 * a real streamable-HTTP MCP server that proxies `tools/list`/`tools/call`
 * of ONE imported server via `McpProxyRegistry`, under the upstream's OWN
 * (unprefixed) tool names — so a bundle can mount it into ANY harness as a
 * first-class MCP server, instead of the two-step `mcp_imported_tool_list`/
 * `mcp_imported_call` indirection `mcp_imported_call` etc. stay for a
 * session already on the daemon's own `/mcp`.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { McpProxyRegistry, ProxyAliasSummary, ProxyCallOutcome, ProxyToolDescriptor } from "../mcp-proxy.js"

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

/** A fake registry backing exactly one import: alias "fake-mcp", id "fake:mcp",
 *  one tool `ping` that echoes back whatever `arguments.text` was sent. */
function fakeProxy(): McpProxyRegistry {
  const aliases: ProxyAliasSummary[] = [
    {
      alias: "fake-mcp",
      importId: "fake:mcp",
      source: "workspace",
      type: "stdio",
      status: "connected",
      toolCount: 1,
    },
  ]
  const tools: ProxyToolDescriptor[] = [
    { name: "ping", description: "echoes text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  ]
  return {
    async listAliases() {
      return aliases
    },
    async listTools(alias: string) {
      if (alias !== "fake:mcp" && alias !== "fake-mcp") return { ok: false, error: `unknown alias "${alias}"` }
      return { ok: true, tools }
    },
    async callTool(alias: string, toolName: string, args: unknown): Promise<ProxyCallOutcome> {
      if (alias !== "fake:mcp" && alias !== "fake-mcp") return { ok: false, error: `unknown alias "${alias}"` }
      if (toolName !== "ping") return { ok: false, error: `no such tool "${toolName}"` }
      const text = (args as { text?: string } | undefined)?.text ?? ""
      return { ok: true, result: { content: [{ type: "text", text: `pong:${text}` }] } }
    },
    async closeAll() {},
  } as unknown as McpProxyRegistry
}

describe("/mcp/imported/<id> — per-import passthrough (PLAN D phase 1)", () => {
  it("lists the upstream's own (unprefixed) tool names and forwards a call through", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      mcpProxy: fakeProxy(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const client = new Client({ name: "imported-passthrough-test", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp/imported/fake:mcp`),
      )
      await client.connect(transport)
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).toEqual(["ping"])

      const result = await client.callTool({ name: "ping", arguments: { text: "hi" } })
      expect(result.content).toEqual([{ type: "text", text: "pong:hi" }])
      await client.close()
    } finally {
      await http.stop()
    }
  })

  it("also resolves by alias (not just the import id)", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      mcpProxy: fakeProxy(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const client = new Client({ name: "imported-passthrough-alias-test", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp/imported/fake-mcp`),
      )
      await client.connect(transport)
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).toEqual(["ping"])
      await client.close()
    } finally {
      await http.stop()
    }
  })

  it("a failed upstream tool call surfaces as an MCP error result, never a hang", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      mcpProxy: fakeProxy(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const client = new Client({ name: "imported-passthrough-error-test", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp/imported/fake:mcp`),
      )
      await client.connect(transport)
      const result = await client.callTool({ name: "does-not-exist", arguments: {} })
      expect(result.isError).toBe(true)
      await client.close()
    } finally {
      await http.stop()
    }
  })

  it("404s an unknown/removed import id", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      mcpProxy: fakeProxy(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp/imported/does-not-exist`)
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toBe("import_not_found")
    } finally {
      await http.stop()
    }
  })

  it("501s when the daemon has no MCP proxy configured", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp/imported/anything`)
      expect(res.status).toBe(501)
    } finally {
      await http.stop()
    }
  })
})
