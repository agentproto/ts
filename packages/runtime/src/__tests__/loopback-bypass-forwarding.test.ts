/**
 * `authorize()` grants a loopback bypass so a local MCP client isn't locked
 * out when `remote_enable` flips bearer auth on. `isLoopback` must therefore
 * be a TIGHT characterisation of "this request never left the machine": a
 * request that reached the loopback socket THROUGH a proxy/tunnel carries a
 * forwarding header and must NOT get the bypass. Keying only on
 * X-Forwarded-For missed proxies that strip XFF but set X-Real-IP / CF-* —
 * this pins the whole-family check.
 *
 * Probed via `POST /heartbeat/tick` (gated by `authorize()`) in bearer mode:
 * a bypassed request 202s; a denied one 401s.
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

const TOKEN = "loopback-test-token"

async function tick(
  port: number,
  headers: Record<string, string>,
): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/heartbeat/tick`, {
    method: "POST",
    headers,
  })
  return res.status
}

describe("isLoopback — forwarding-header family denies the bypass", () => {
  it("bypasses a pure loopback request but not a proxied one", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "bearer", token: TOKEN },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      // Pure loopback, no forwarding header → bypass → 202 (no token needed).
      expect(await tick(port, {})).toBe(202)

      // A valid bearer token always passes.
      expect(await tick(port, { authorization: `Bearer ${TOKEN}` })).toBe(202)

      // A proxy that stripped X-Forwarded-For but set X-Real-IP must NOT be
      // treated as loopback → no bypass → 401.
      expect(await tick(port, { "x-real-ip": "203.0.113.7" })).toBe(401)

      // Classic X-Forwarded-For is still denied.
      expect(await tick(port, { "x-forwarded-for": "203.0.113.7" })).toBe(401)

      // A CF-* header (Cloudflare) is denied too.
      expect(await tick(port, { "cf-connecting-ip": "203.0.113.7" })).toBe(401)
    } finally {
      await http.stop()
    }
  })
})
