/**
 * Cross-origin READ gate. CORS answers `Access-Control-Allow-Origin: *` to an
 * untrusted origin (that is what lets a page probe `/health`), so every other
 * GET/HEAD route that returns local state must refuse a foreign browser Origin
 * (including `null`, which sandboxed/opaque frames send) on its own.
 *
 * Raw node:http requests so the Origin header is exactly what is tested.
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionsRegistry } from "../sessions.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }))
    })
    req.once("error", reject)
    req.end()
  })
}

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

async function withDaemon(
  fn: (ctx: { port: number; sessionId: string }) => Promise<void>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const port = await freePort()
  const sessions = createSessionsRegistry({ persist: false })
  const desc = sessions.registerBrowser({
    adapterId: "chrome-live",
    port: 9222,
    baseUrl: "http://127.0.0.1:9222",
    wasAlreadyRunning: true,
    stop: async () => {},
  })
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations,
    events: createRuntimeEvents(),
    heartbeat,
    sessions,
    meta: { workspace: process.cwd(), registered: [] },
    ...extra,
  })
  try {
    await fn({ port, sessionId: desc.id })
  } finally {
    await http.stop()
  }
}

const FOREIGN = ["https://evil.example", "http://evil.example:8080", "null"]

describe("cross-origin read gate", () => {
  it("refuses a foreign Origin (and `null`) on read routes that return local state", async () => {
    await withDaemon(async ({ port, sessionId }) => {
      const paths = [
        "/sessions",
        `/sessions/${sessionId}`,
        `/sessions/${sessionId}/export`,
        `/sessions/${sessionId}/events`,
        "/usage/rollup",
        "/auth/profiles",
        "/adapters",
        "/harnesses",
        "/capabilities/inventory",
        "/host/load",
        "/identity",
        "/tunnels",
        "/pairings",
        "/permissions",
        "/user-presets",
        "/cron",
        "/devices",
        "/mcps/discovered",
        "/sandboxes/egress-health",
        "/spawn-admission",
        "/conversations",
        "/workspaces",
      ]
      for (const origin of FOREIGN) {
        for (const path of paths) {
          const r = await get(port, path, { origin })
          expect(r.status, `${origin} ${path}`).toBe(403)
          expect(r.body, `${origin} ${path}`).toContain("forbidden_origin")
        }
        // HEAD is gated like GET.
        expect((await get(port, "/sessions", { origin }, "HEAD")).status, `HEAD ${origin}`).toBe(403)
      }
    })
  })

  it("keeps `/health` open to any origin (public probe)", async () => {
    await withDaemon(async ({ port }) => {
      for (const origin of FOREIGN) {
        const r = await get(port, "/health", { origin })
        expect(r.status, origin).toBe(200)
        expect(r.headers["access-control-allow-origin"], origin).toBe("*")
        expect(r.headers["access-control-allow-credentials"], origin).toBeUndefined()
      }
    })
  })

  it("lets native clients (no Origin) and allowlisted origins through", async () => {
    await withDaemon(async ({ port, sessionId }) => {
      // Not 403: some routes answer 404/501 here because this test daemon wires no registry for them.
      for (const path of ["/sessions", `/sessions/${sessionId}`, "/host/load", "/cron", "/adapters", "/identity"]) {
        expect((await get(port, path)).status, `native ${path}`).not.toBe(403)
        const trusted = await get(port, path, { origin: `http://127.0.0.1:${port}` })
        expect(trusted.status, `allowlisted ${path}`).not.toBe(403)
      }
      for (const path of ["/sessions", `/sessions/${sessionId}`, "/host/load"]) {
        expect((await get(port, path)).status, `native ${path}`).toBe(200)
        const trusted = await get(port, path, { origin: `http://127.0.0.1:${port}` })
        expect(trusted.status, `allowlisted ${path}`).toBe(200)
        expect(trusted.headers["access-control-allow-origin"]).toBe(`http://127.0.0.1:${port}`)
      }
    })
  })

  it("lets an operator-allowlisted origin through, and strictOrigins removes the localhost default", async () => {
    await withDaemon(
      async ({ port }) => {
        expect((await get(port, "/sessions", { origin: "https://app.example.com" })).status).toBe(200)
      },
      { allowedOrigins: ["https://app.example.com"] },
    )
    await withDaemon(
      async ({ port }) => {
        expect((await get(port, "/sessions", { origin: `http://127.0.0.1:${port}` })).status).toBe(403)
      },
      { strictOrigins: true, allowedOrigins: ["https://app.example.com"] },
    )
  })

  it("lets a foreign Origin through only with the daemon bearer", async () => {
    await withDaemon(
      async ({ port }) => {
        const origin = "https://evil.example"
        expect((await get(port, "/sessions", { origin })).status).toBe(403)
        expect((await get(port, "/sessions", { origin, authorization: "Bearer wrong" })).status).toBe(403)
        expect((await get(port, "/sessions", { origin, authorization: "Bearer s3cret" })).status).toBe(200)
      },
      { auth: { mode: "bearer", token: "s3cret" } },
    )
  })

  it("lets a foreign Origin through with the per-boot token (header or ?token=), not with a wrong one", async () => {
    await withDaemon(
      async ({ port }) => {
        const origin = "https://evil.example"
        expect((await get(port, "/sessions", { origin })).status).toBe(403)
        expect((await get(port, "/sessions?token=nope", { origin })).status).toBe(403)
        expect((await get(port, "/sessions", { origin, authorization: "Bearer tkn" })).status).toBe(200)
        expect((await get(port, "/sessions?token=tkn", { origin })).status).toBe(200)
      },
      { token: "tkn" },
    )
  })

  it("the per-boot token also opens HEAD and non-session read routes; `/approvals*` keeps its own gate", async () => {
    await withDaemon(
      async ({ port }) => {
        const origin = "https://evil.example"
        expect((await get(port, "/host/load", { origin })).status).toBe(403)
        expect((await get(port, "/host/load?token=tkn", { origin })).status).toBe(200)
        // HEAD passes the gate (the route itself may not implement HEAD).
        expect((await get(port, "/sessions?token=tkn", { origin }, "HEAD")).status).not.toBe(403)
        // Not this gate's route: with no approvals engine wired it falls through (404), it is not a 403 from here.
        expect((await get(port, "/approvals", { origin })).status).not.toBe(403)
      },
      { token: "tkn" },
    )
  })

  it("does not change write routes' own 401 contract", async () => {
    await withDaemon(async ({ port }) => {
      const r = await get(port, "/sessions", { origin: "https://evil.example", "content-type": "application/json" }, "POST")
      expect(r.status).toBe(401)
    }, { token: "tkn" })
  })
})
