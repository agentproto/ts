/**
 * The `/mcp` endpoint registers `command_execute`, `file_read`/`file_write`,
 * `agent_start`, … — a full shell + filesystem surface. It used to be gated
 * only by `authorize()`, which returns true in `mode: "none"` (the default)
 * AND has a loopback bypass, so a malicious web page could `fetch()`
 * `http://127.0.0.1:<port>/mcp` and drive those tools (CVE-2026-22812 class).
 *
 * `authorizeMcp` closes that: a cross-origin browser request (which ALWAYS
 * carries an `Origin` the page can't forge) from an untrusted origin is 403'd
 * even from loopback / mode none, while native local clients (no `Origin`)
 * and trusted browser origins (localhost dev, the hosted panel) still pass.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
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
  return (await createMcpServer({ specs: [], name: "main", version: "0" }))
    .server
}

/** POST /mcp with the given headers; returns the HTTP status. */
async function postMcp(
  port: number,
  headers: Record<string, string>,
): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })
  return res.status
}

describe("/mcp gate — browser drive-by defense", () => {
  it("403s an untrusted cross-origin browser request, even at mode:none", async () => {
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
      // A malicious web page fetching the loopback daemon: Origin is set by
      // the browser and can't be forged to a trusted value → refused.
      const evil = await postMcp(port, { origin: "https://evil.example.com" })
      expect(evil).toBe(403)

      // A trusted localhost dev origin is NOT blocked by the gate (it then
      // reaches the MCP transport, whatever status that yields).
      const localhost = await postMcp(port, {
        origin: "http://localhost:3000",
      })
      expect(localhost).not.toBe(403)

      // A native local MCP client sends no Origin header → preserved: the
      // gate falls through to authorize() (loopback bypass in mode none).
      const bare = await postMcp(port, {})
      expect(bare).not.toBe(403)
    } finally {
      await http.stop()
    }
  })
})
