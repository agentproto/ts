/**
 * Daemon-level guarantees of the MCP App sandbox origin, against a real
 * `startHttpServer` (raw node:http requests so Host/Origin/Referer are exactly
 * what is tested — fetch would normalise or refuse them).
 *
 * R1  a request carrying a sandbox Origin/Referer is 403 on EVERY daemon route
 *     (also for preflights, the WS upgrade, and even when the operator's own
 *     allowlist names the sandbox origin);
 * R2  a sandbox Host serves documents only and never reaches a daemon route.
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { connect } from "node:net"
import { describe, expect, it } from "vitest"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const HTML = "<!doctype html><html><head></head><body>sandboxed-view</body></html>"

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function raw(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      )
    })
    req.once("error", reject)
    if (body !== undefined) req.write(body)
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
  fn: (port: number) => Promise<void>,
  extra: Partial<RuntimeHttpServerOptions> = {},
): Promise<void> {
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations,
    events: createRuntimeEvents(),
    heartbeat,
    meta: { workspace: process.cwd(), registered: [] },
    ...extra,
  })
  try {
    await fn(port)
  } finally {
    await http.stop()
  }
}

async function register(
  port: number,
  body: unknown = { html: HTML, csp: { connectDomains: ["https://api.example.com"] } },
  headers: Record<string, string> = {},
): Promise<Reply> {
  const payload = JSON.stringify(body)
  return raw(
    port,
    "POST",
    "/mcp-app-sandbox/views",
    {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
      ...headers,
    },
    payload,
  )
}

describe("MCP App sandbox — registration route", () => {
  it("registers a view and returns a sandbox-origin URL distinct from the daemon's", async () => {
    await withDaemon(async (port) => {
      const r = await register(port)
      expect(r.status).toBe(200)
      const j = JSON.parse(r.body) as { url: string; origin: string; token: string; mode: string }
      expect(j.mode).toBe("subdomain")
      expect(j.origin).toBe(`http://${j.token}.sandbox.localhost:${port}`)
      expect(j.origin).not.toBe(`http://127.0.0.1:${port}`)
      expect(j.url).toBe(`${j.origin}/v/${j.token}`)
    })
  })

  it("needs the daemon's session gate: a foreign Origin and no bearer is 401", async () => {
    await withDaemon(
      async (port) => {
        const r = await register(port, undefined, { origin: "https://evil.example.com" })
        expect(r.status).toBe(401)
      },
      { token: "tkn" },
    )
  })

  it("accepts the bearer", async () => {
    await withDaemon(
      async (port) => {
        const r = await register(port, undefined, { origin: "https://evil.example.com", authorization: "Bearer tkn" })
        expect(r.status).toBe(200)
      },
      { token: "tkn" },
    )
  })

  it("rejects bad bodies and oversized bodies", async () => {
    await withDaemon(
      async (port) => {
        expect((await register(port, { nope: 1 })).status).toBe(400)
        const tooBigHtml = await register(port, { html: "x".repeat(2000) })
        expect(tooBigHtml.status).toBe(400)
        expect(tooBigHtml.body).toContain("html_too_large")
        // Far past the cap: refused while streaming, before the JSON is parsed.
        expect((await register(port, { html: "x".repeat(200_000) })).status).toBe(413)
      },
      { mcpAppSandbox: { maxHtmlBytes: 1000 } },
    )
  })

  it("refuses a simple cross-origin form POST (text/plain): JSON is required so a preflight happens", async () => {
    await withDaemon(async (port) => {
      const payload = JSON.stringify({ html: HTML })
      const r = await raw(
        port,
        "POST",
        "/mcp-app-sandbox/views",
        {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          "content-type": "text/plain",
          "content-length": String(Buffer.byteLength(payload)),
        },
        payload,
      )
      expect(r.status).toBe(415)
    })
  })

  it("a remote page (non-loopback host) without a public origin gets 501, so the host falls back to restricted mode", async () => {
    await withDaemon(async (port) => {
      const r = await register(port, undefined, {
        host: "app.example.com",
        origin: "https://app.example.com",
        "x-forwarded-for": "203.0.113.9",
      })
      expect(r.status).toBe(501)
      expect(r.body).toContain("sandbox_unavailable_for_remote_host")
    })
  })

  it("mode off: 501, and hosts fall back to the opaque srcdoc", async () => {
    await withDaemon(
      async (port) => {
        expect((await register(port)).status).toBe(501)
      },
      { mcpAppSandbox: { mode: "off" } },
    )
  })
})

describe("MCP App sandbox — serving (R2)", () => {
  it("serves the document on its own sandbox host with the CSP as a header and frame-ancestors pinned", async () => {
    await withDaemon(async (port) => {
      const j = JSON.parse((await register(port)).body) as { token: string }
      const r = await raw(port, "GET", `/v/${j.token}`, { host: `${j.token}.sandbox.localhost:${port}` })
      expect(r.status).toBe(200)
      expect(r.body).toBe(HTML)
      const csp = String(r.headers["content-security-policy"])
      expect(csp).toContain("connect-src 'self' https://api.example.com")
      expect(csp).toContain(`frame-ancestors http://127.0.0.1:${port}`)
      expect(r.headers["access-control-allow-origin"]).toBeUndefined()
    })
  })

  it("never reaches a daemon route through a sandbox host", async () => {
    await withDaemon(async (port) => {
      const j = JSON.parse((await register(port)).body) as { token: string }
      const host = `${j.token}.sandbox.localhost:${port}`
      for (const [method, path] of [
        ["GET", "/health"],
        ["GET", "/sessions"],
        ["POST", "/sessions"],
        ["POST", "/mcp"],
        ["GET", "/events"],
        ["GET", "/apps/x/ui"],
        ["POST", "/mcp-app-sandbox/views"],
        ["GET", "/files/upload"],
      ] as const) {
        const r = await raw(port, method, path, { host })
        expect([404, 405], `${method} ${path}`).toContain(r.status)
        expect(r.body).not.toContain('"status":"ok"')
      }
    })
  })

  it("a document is not served on another view's origin, nor on the daemon's own host", async () => {
    await withDaemon(async (port) => {
      const a = JSON.parse((await register(port)).body) as { token: string }
      const b = JSON.parse((await register(port)).body) as { token: string }
      const cross = await raw(port, "GET", `/v/${a.token}`, { host: `${b.token}.sandbox.localhost:${port}` })
      expect(cross.status).toBe(404)
      const onDaemon = await raw(port, "GET", `/v/${a.token}`, { host: `127.0.0.1:${port}` })
      expect(onDaemon.body).not.toContain("sandboxed-view")
    })
  })
})

describe("MCP App sandbox — publicOrigin topology", () => {
  it("a dedicated public hostname serves views only; the daemon API is unreachable on it", async () => {
    await withDaemon(
      async (port) => {
        const j = JSON.parse((await register(port, undefined, { host: "app.example.com", origin: "https://app.example.com", "x-forwarded-for": "203.0.113.9" })).body) as {
          token: string
          origin: string
          mode: string
        }
        expect(j.mode).toBe("public")
        expect(j.origin).toBe("https://sbx.example.com")
        const doc = await raw(port, "GET", `/v/${j.token}`, { host: "sbx.example.com" })
        expect(doc.status).toBe(200)
        expect(String(doc.headers["content-security-policy"])).toContain("frame-ancestors https://app.example.com")
        for (const path of ["/health", "/sessions", "/mcp", "/events"]) {
          const r = await raw(port, "GET", path, { host: "sbx.example.com" })
          expect(r.status, path).toBe(404)
        }
      },
      { mcpAppSandbox: { publicOrigin: "https://sbx.example.com" } },
    )
  })
})

describe("MCP App sandbox — a sandbox origin is never trusted (R1)", () => {
  const sandboxOrigin = (port: number) => `http://abc123.sandbox.localhost:${port}`
  const ROUTES: Array<[string, string]> = [
    ["GET", "/health"],
    ["GET", "/events"],
    ["GET", "/sessions"],
    ["POST", "/sessions"],
    ["POST", "/mcp"],
    ["POST", "/files/upload"],
    ["POST", "/mcp-app-sandbox/views"],
    ["GET", "/apps/@x/y/ui"],
    ["OPTIONS", "/mcp"],
  ]

  it("403 on every daemon route when the Origin is a sandbox origin", async () => {
    await withDaemon(async (port) => {
      for (const [method, path] of ROUTES) {
        const r = await raw(port, method, path, { host: `127.0.0.1:${port}`, origin: sandboxOrigin(port) })
        expect(r.status, `${method} ${path}`).toBe(403)
        expect(r.body, `${method} ${path}`).toContain("forbidden_sandbox_origin")
        expect(r.headers["access-control-allow-origin"], `${method} ${path}`).toBeUndefined()
      }
    })
  })

  it("403 when only the Referer is a sandbox origin (no-cors GETs carry no Origin)", async () => {
    await withDaemon(async (port) => {
      const r = await raw(port, "GET", "/health", {
        host: `127.0.0.1:${port}`,
        referer: `${sandboxOrigin(port)}/v/abc`,
      })
      expect(r.status).toBe(403)
    })
  })

  it("403 even when the operator's allowlist explicitly names the sandbox origin", async () => {
    await withDaemon(
      async (port) => {
        const r = await raw(port, "GET", "/health", { host: `127.0.0.1:${port}`, origin: sandboxOrigin(port) })
        expect(r.status).toBe(403)
        const ok = await raw(port, "GET", "/health", { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })
        expect(ok.status).toBe(200)
      },
      { allowedOrigins: ["http://*.sandbox.localhost:*", "http://abc123.sandbox.localhost:*"] },
    )
  })

  it("403 for the dedicated sandbox port origin too (port mode), also under the loopback allowlist", async () => {
    const sbxPort = await freePort()
    await withDaemon(
      async (port) => {
        // http://127.0.0.1:* is in the default allowlist; the sandbox port must still be refused.
        const r = await raw(port, "POST", "/sessions", { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${sbxPort}` })
        expect(r.status).toBe(403)
        const reg = JSON.parse((await register(port)).body) as { url: string; origin: string; token: string; mode: string }
        expect(reg.mode).toBe("port")
        expect(reg.origin).toBe(`http://127.0.0.1:${sbxPort}`)
        const doc = await raw(sbxPort, "GET", `/v/${reg.token}`, { host: `127.0.0.1:${sbxPort}` })
        expect(doc.status).toBe(200)
        expect(doc.body).toBe(HTML)
        const health = await raw(sbxPort, "GET", "/health", { host: `127.0.0.1:${sbxPort}` })
        expect(health.status).toBe(404)
        const badHost = await raw(sbxPort, "GET", `/v/${reg.token}`, { host: "evil.example.com" })
        expect(badHost.status).toBe(403)
      },
      { mcpAppSandbox: { mode: "port", port: sbxPort } },
    )
  })

  it("the daemon's own origin keeps working (the guard is not a blanket block)", async () => {
    await withDaemon(async (port) => {
      const r = await raw(port, "GET", "/health", { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })
      expect(r.status).toBe(200)
    })
  })

  it("refuses a WebSocket upgrade from a sandbox origin and to a sandbox host", async () => {
    await withDaemon(async (port) => {
      const handshake = (extra: string, host: string) =>
        new Promise<string>((resolve, reject) => {
          const sock = connect(port, "127.0.0.1", () => {
            sock.write(
              `GET /sessions/x/pty HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
                `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`,
            )
          })
          let data = ""
          sock.on("data", (d) => (data += d.toString()))
          sock.on("close", () => resolve(data))
          sock.on("error", reject)
          setTimeout(() => sock.destroy(), 1500)
        })
      const fromSandbox = await handshake(`Origin: ${sandboxOrigin(port)}\r\n`, `127.0.0.1:${port}`)
      expect(fromSandbox).toContain("403")
      const toSandboxHost = await handshake("", `abc.sandbox.localhost:${port}`)
      expect(toSandboxHost).toContain("403")
    })
  })
})
