/**
 * DNS-rebinding defense. A page that points `evil.com` at `127.0.0.1` and
 * fetches the daemon still sends its own hostname in `Host`. `validateHost`
 * requires a loopback `Host` on the loopback socket path, so that request is
 * refused (403) — complementing the Origin guards, which stop the direct
 * browser drive-by. `/health` is exempt.
 *
 * `fetch` forbids setting the `Host` header, so this drives raw `node:http`.
 */

import { describe, it, expect } from "vitest"
import { createServer, request } from "node:http"
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

/** GET `path` over raw http, optionally overriding the `Host` header. */
function get(
  port: number,
  path: string,
  host?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        ...(host ? { headers: { host } } : {}),
      },
      res => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on("error", reject)
    req.end()
  })
}

describe("validateHost — DNS-rebinding guard", () => {
  it("refuses a non-loopback Host on the loopback path; /health is exempt", async () => {
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
      // Default Host (node sends 127.0.0.1:<port>) → allowed.
      expect(await get(port, "/conversations")).not.toBe(403)

      // Explicit localhost:<port> Host → allowed.
      expect(await get(port, "/conversations", `localhost:${port}`)).not.toBe(403)

      // A rebinding page's Host (its own domain) → refused.
      expect(await get(port, "/conversations", "evil.example.com")).toBe(403)
      expect(await get(port, "/conversations", `evil.example.com:${port}`)).toBe(
        403,
      )

      // /health stays reachable regardless of Host (public probe).
      expect(await get(port, "/health", "evil.example.com")).toBe(200)
    } finally {
      await http.stop()
    }
  })
})
