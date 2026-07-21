/**
 * The daemon's read routes leak local session state: `GET /conversations`
 * (+ `/:id`) returns conversation transcripts, `GET /events` is the live
 * runtime SSE stream, `/workspaces` + `/worktrees` expose local paths. They
 * were gated only by `authorize()` (loopback bypass) or not at all, and with
 * the reflected-origin CORS a malicious page the user visits could `fetch()`
 * them cross-origin and READ the response — no `/mcp` needed.
 *
 * `guardBrowserOrigin` closes that: a cross-origin browser request (which
 * always carries an unforgeable `Origin`) from an untrusted origin is 403'd
 * even at `mode:"none"`, while native clients (no `Origin`) and trusted
 * origins still pass. CORS is also tightened so only allowlisted origins get
 * a credentialed, reflected `Access-Control-Allow-Origin`.
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

const EVIL = "https://evil.example.com"
const TRUSTED = "http://localhost:3000"

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

describe("read routes — browser drive-by defense", () => {
  it("403s untrusted cross-origin reads; allows trusted + native", async () => {
    const port = await freePort()
    const http = await start(port)
    try {
      const get = (path: string, origin?: string, signal?: AbortSignal) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          headers: origin ? { origin } : {},
          ...(signal ? { signal } : {}),
        })

      // /conversations — untrusted origin is refused even at mode:none.
      expect((await get("/conversations", EVIL)).status).toBe(403)
      // A trusted localhost dev origin passes the gate.
      expect((await get("/conversations", TRUSTED)).status).not.toBe(403)
      // A native client (no Origin) is preserved.
      expect((await get("/conversations")).status).not.toBe(403)

      // /events (SSE) — fetch resolves on headers, so status is available
      // before the stream body. Untrusted → 403.
      expect((await get("/events", EVIL)).status).toBe(403)
      // Trusted → not 403; abort so the keep-alive stream doesn't hang.
      const ac = new AbortController()
      const evtRes = await get("/events", TRUSTED, ac.signal)
      expect(evtRes.status).not.toBe(403)
      ac.abort()
    } finally {
      await http.stop()
    }
  })

  it("reflects a credentialed CORS origin only for allowlisted origins", async () => {
    const port = await freePort()
    const http = await start(port)
    try {
      const evil = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { origin: EVIL },
      })
      // Untrusted origin: bare `*`, never reflected-with-credentials.
      expect(evil.headers.get("access-control-allow-origin")).toBe("*")
      expect(evil.headers.get("access-control-allow-credentials")).toBeNull()

      const trusted = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { origin: TRUSTED },
      })
      expect(trusted.headers.get("access-control-allow-origin")).toBe(TRUSTED)
      expect(trusted.headers.get("access-control-allow-credentials")).toBe(
        "true",
      )
    } finally {
      await http.stop()
    }
  })
})
