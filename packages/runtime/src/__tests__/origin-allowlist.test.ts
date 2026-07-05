/**
 * The daemon gates mutating /sessions/* routes AND the /sessions/:id/pty
 * WebSocket upgrade behind `checkSessionsToken`, which accepts a trusted
 * browser Origin as an alternative to the per-boot token (browsers can't
 * set an Authorization header on a WS upgrade). The hosted panel at
 * cli.agentproto.sh drives the user's local daemon from the browser: its
 * read-only GETs work ungated, but the PTY terminal's WS upgrade 401'd
 * because that origin wasn't trusted. This locks cli.agentproto.sh (and the
 * localhost dev origins) into the allowlist and a random origin out.
 *
 * The gate runs identically for the PTY WS upgrade and for mutating HTTP
 * routes, and fires BEFORE session resolution, so `POST /sessions/:id/kill`
 * against a nonexistent id is a faithful, WS-free probe of the same gate.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
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
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

const TOKEN = "test-secret-token"

/** POST a gated mutating route with the given headers; returns the status. */
async function killWith(
  port: number,
  headers: Record<string, string>,
): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/sessions/nope/kill`, {
    method: "POST",
    headers,
  })
  return res.status
}

describe("sessions gate — Origin allowlist", () => {
  it("trusts the hosted panel origin and rejects unknown origins", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      token: TOKEN,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: createSessionsRegistry({ persist: false }),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      // Control: a valid Bearer token passes the gate (→ not 401; the kill
      // handler then 404s the nonexistent session).
      const withToken = await killWith(port, {
        authorization: `Bearer ${TOKEN}`,
      })
      expect(withToken).not.toBe(401)

      // The hosted panel origin is now trusted like localhost — same
      // outcome as the token, NOT a 401.
      const panelOrigin = await killWith(port, {
        origin: "https://cli.agentproto.sh",
      })
      expect(panelOrigin).toBe(withToken)
      expect(panelOrigin).not.toBe(401)

      // A localhost dev origin (existing default) also passes.
      const localhost = await killWith(port, {
        origin: "http://localhost:3000",
      })
      expect(localhost).not.toBe(401)

      // An arbitrary origin is rejected — the gate is not open to the world.
      const evil = await killWith(port, {
        origin: "https://evil.example.com",
      })
      expect(evil).toBe(401)

      // No Origin and no token → rejected.
      const bare = await killWith(port, {})
      expect(bare).toBe(401)
    } finally {
      await http.stop()
    }
  })
})
