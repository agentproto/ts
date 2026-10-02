/**
 * `server/discover` must never advertise a protocol version the transport
 * doesn't actually serve. Claude Code 2.1.280 probes `server/discover` next
 * to `initialize`; when it read `supportedVersions: ["2026-07-28"]` it
 * switched to the "modern" era, got an invalid `tools/list` result and mounted
 * 0 tools while the server still showed `connected`. The transport only speaks
 * 2025-11-25 (it coerces the 2026-07-28 header down — FIX-10 / #1508), so
 * discover either isn't answered (-32601 → legacy era) or only lists versions
 * for which `tools/list` returns a valid, non-empty result.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer, registerEventsMethods } from "@agentproto/mcp-server"

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
  registerEventsMethods(server, {
    list: async () => ({ events: [], nextCursor: null }),
    subscribe: async () => ({}),
    unsubscribe: async () => ({}),
  })
  return server
}

async function withDaemon(fn: (port: number) => Promise<void>): Promise<void> {
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
    await fn(port)
  } finally {
    await http.stop()
  }
}

async function postRpc(port: number, protocolVersion: string, method: string): Promise<Record<string, any>> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
  })
  const body = await res.text()
  const dataLine = body.split("\n").find(line => line.startsWith("data:"))
  return JSON.parse(dataLine ? dataLine.slice("data:".length).trim() : body)
}

describe("/mcp — server/discover never advertises an unserved protocol version", () => {
  it("answers -32601, or only lists versions whose tools/list is valid and non-empty", async () => {
    await withDaemon(async port => {
      const discover = await postRpc(port, "2026-07-28", "server/discover")
      if (discover.error) {
        expect(discover.error.code).toBe(-32601)
        return
      }
      const versions = discover.result.supportedVersions as string[]
      expect(versions.length).toBeGreaterThan(0)
      for (const version of versions) {
        const list = await postRpc(port, version, "tools/list")
        expect(list.error, `tools/list under advertised ${version}`).toBeUndefined()
        expect(Array.isArray(list.result?.tools), `tools/list under advertised ${version}`).toBe(true)
        expect(list.result.tools.length).toBeGreaterThan(0)
      }
    })
  })

  it("a legacy SDK client still gets > 0 tools with registerEventsMethods active", async () => {
    await withDaemon(async port => {
      const client = new Client({ name: "discover-compat-test", version: "0.0.1" })
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
      try {
        expect(client.getServerVersion()).toBeDefined()
        const { tools } = await client.listTools()
        expect(tools.length).toBeGreaterThan(0)
        expect(tools.map(t => t.name)).toContain("probe")
      } finally {
        await client.close()
      }
    })
  })
})
