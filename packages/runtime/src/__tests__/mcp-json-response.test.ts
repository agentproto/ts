/**
 * MCP Apps host round-trip over a JSON-only Accept header.
 *
 * The daemon's `/mcp` endpoint follows the SDK's stateless pattern, and the
 * SDK's default response mode is SSE: a POST answer is an SSE stream whose
 * `data:` line carries the JSON-RPC response, and the stream closes right
 * after that first response. A host that opened the transport the modern way
 * (Accept: application/json, no text/event-stream) is refused outright with
 * 406 "Not Acceptable: Client must accept both application/json and
 * text/event-stream" before any tool call is served, and a host that treats
 * the response body as strict JSON-RPC sees the SSE envelope as a transport
 * fault (the observed "Transport closed" on the app iframe's follow-up
 * tools/call).
 *
 * `serveMcp` now answers POST with a plain `application/json` body and stops
 * bouncing a JSON-only Accept, so an MCP Apps host can drive `initialize`,
 * `tools/call agentproto_work_board` and a later `tools/call task_list` on the
 * same session without a transport close in between.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port
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
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  server.tool("agentproto_work_board", "work board", {}, async () => ({
    content: [{ type: "text", text: JSON.stringify({ boardId: "ws:default", tasks: [] }) }],
  }))
  server.tool("task_list", "task list", {}, async () => ({
    content: [{ type: "text", text: JSON.stringify({ items: [] }) }],
  }))
  return server
}

/** Raw JSON-RPC POST to /mcp with an explicit Accept header. */
async function post(port: number, method: string, params: Record<string, unknown>, accept: string) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
}

async function start(port: number) {
  return startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
  })
}

describe("/mcp - JSON response over a JSON-only Accept (MCP Apps host)", () => {
  it("serves initialize, then two tools/call on the same JSON-only session without a 406", async () => {
    const port = await freePort()
    const http = await start(port)
    try {
      const accept = "application/json"

      const init = await post(port, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "host", version: "0" },
      }, accept)
      expect(init.status).toBe(200)
      expect(init.headers.get("content-type")).toContain("application/json")
      expect(await init.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "main" } } })

      const wb = await post(port, "tools/call", { name: "agentproto_work_board", arguments: {} }, accept)
      expect(wb.status).toBe(200)
      expect(wb.headers.get("content-type")).toContain("application/json")
      expect(await wb.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text" }] } })

      const tl = await post(port, "tools/call", { name: "task_list", arguments: {} }, accept)
      expect(tl.status).toBe(200)
      expect(tl.headers.get("content-type")).toContain("application/json")
      const body = (await tl.json()) as { result?: { content?: Array<{ text?: string }> } }
      expect(body.result?.content?.[0]?.text).toContain("items")
    } finally {
      await http.stop()
    }
  })

  it("keeps the legacy Accept path working (full SDK client round trip)", async () => {
    const port = await freePort()
    const http = await start(port)
    try {
      const client = new Client({ name: "legacy", version: "0.0.1" })
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
      const tools = await client.listTools()
      expect(tools.tools.map(t => t.name)).toContain("task_list")
      const r = await client.callTool({ name: "task_list", arguments: {} })
      expect(r).toMatchObject({ content: [{ type: "text" }] })
      await client.close()
    } finally {
      await http.stop()
    }
  })
})
