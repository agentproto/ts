/**
 * FIX-10: the SDK's `StreamableHTTPServerTransport` (1.30.x) rejects any
 * `mcp-protocol-version` request header outside its own
 * `SUPPORTED_PROTOCOL_VERSIONS` with a 400 — including one that's simply
 * NEWER than this SDK knows about. An updated Claude Code client now sends
 * `2026-07-28`; against this SDK (whose latest known version is
 * `2025-11-25`) every post-initialize request from that client 400s, and
 * the client surfaces it as "Server agentproto unavailable" (see
 * `daemon.log`: 1701 lines of `Bad Request: Unsupported protocol version:
 * 2026-07-28`). `serveMcp` in `../http-server.ts` now rewrites an unknown
 * *newer* header down to the SDK's `LATEST_PROTOCOL_VERSION` before the
 * transport parses it, so the client's own `initialize` negotiation (which
 * already correctly downgrades to `LATEST_PROTOCOL_VERSION` server-side,
 * per the SDK's `_oninitialize`) is not undone by the transport's
 * per-request header check.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
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
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  server.tool("probe", "probe tool", {}, async () => ({
    content: [{ type: "text", text: "probe" }],
  }))
  return server
}

/** POST a `tools/list` JSON-RPC request to /mcp with a given protocol-version header. */
async function postToolsList(port: number, protocolVersion: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  })
}

/**
 * The transport's default (non-JSON) response mode is SSE, even for a
 * single immediate result — one `data:` line carries the JSON-RPC
 * response. Pull it out for assertions.
 */
function parseSingleSseMessage(body: string): unknown {
  const dataLine = body.split("\n").find(line => line.startsWith("data:"))
  if (!dataLine) throw new Error(`no SSE data line in body: ${body}`)
  return JSON.parse(dataLine.slice("data:".length).trim())
}

describe("/mcp — mcp-protocol-version header tolerance", () => {
  it("accepts a protocol version newer than the SDK knows about", async () => {
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
      const res = await postToolsList(port, "2026-07-28")
      const body = await res.text()
      expect(res.status).toBe(200)
      expect(parseSingleSseMessage(body)).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{ name: "probe" }] },
      })
    } finally {
      await http.stop()
    }
  })

  it("still accepts a version the SDK actually supports", async () => {
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
      const res = await postToolsList(port, LATEST_PROTOCOL_VERSION)
      const body = await res.text()
      expect(res.status).toBe(200)
      expect(parseSingleSseMessage(body)).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{ name: "probe" }] },
      })
    } finally {
      await http.stop()
    }
  })

  it("still 400s an unsupported version that ISN'T newer (not a blanket bypass)", async () => {
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
      const res = await postToolsList(port, "2020-01-01")
      expect(res.status).toBe(400)
    } finally {
      await http.stop()
    }
  })

  it("initialize negotiation is unaffected end-to-end (full SDK client round trip)", async () => {
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
      const client = new Client({ name: "protocol-version-test", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
      await client.connect(transport)
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).toEqual(["probe"])
      await client.close()
    } finally {
      await http.stop()
    }
  })
})
