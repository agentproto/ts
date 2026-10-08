import { describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createEventsSurfaceServer } from "../mcp-events-surface.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const SECRET = "s3cr3t-".repeat(6)
const DAEMON_TOKEN = "daemon-bearer-token-not-the-events-secret"

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
}

const MODERN_HEADERS = {
  "content-type": "application/json",
  accept: "application/json",
  "mcp-protocol-version": "2026-07-28",
  "mcp-method": "server/discover",
}

const DISCOVER_BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: META } })

async function withServer(
  extra: Partial<RuntimeHttpServerOptions>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
    ...extra,
  })
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await http.stop()
  }
}

const eventsMcp = {
  secret: SECRET,
  createServer: async () =>
    createEventsSurfaceServer({
      version: "0",
      repoAllowlist: [],
      handlers: {
        list: async () => ({ events: [] }),
        subscribe: async () => ({}),
        unsubscribe: async () => ({}),
      },
    }),
}

describe("events surface: /mcp/events route", () => {
  it("404s when eventsMcp is not configured, even with a plausible secret", async () => {
    await withServer({}, async base => {
      const res = await fetch(`${base}/mcp/events/${SECRET}`, { method: "POST", headers: MODERN_HEADERS, body: DISCOVER_BODY })
      expect(res.status).toBe(404)
    })
  })

  it("404s on a wrong secret and on a missing secret, with no-store", async () => {
    await withServer({ eventsMcp }, async base => {
      for (const path of [`/mcp/events/${SECRET}x`, "/mcp/events/short", "/mcp/events/"]) {
        const res = await fetch(`${base}${path}`, { method: "POST", headers: MODERN_HEADERS, body: DISCOVER_BODY })
        expect(res.status).toBe(404)
        expect(res.headers.get("cache-control")).toBe("no-store")
      }
    })
  })

  it("403s any Origin by default, even with the right secret", async () => {
    await withServer({ eventsMcp }, async base => {
      const res = await fetch(`${base}/mcp/events/${SECRET}`, {
        method: "POST",
        headers: { ...MODERN_HEADERS, origin: "https://evil.example" },
        body: DISCOVER_BODY,
      })
      expect(res.status).toBe(403)
    })
  })

  it("accepts an Origin listed in allowedOrigins", async () => {
    await withServer({ eventsMcp: { ...eventsMcp, allowedOrigins: ["https://ok.example"] } }, async base => {
      const res = await fetch(`${base}/mcp/events/${SECRET}`, {
        method: "POST",
        headers: { ...MODERN_HEADERS, origin: "https://ok.example" },
        body: DISCOVER_BODY,
      })
      expect(res.status).toBe(200)
    })
  })

  it("serves server/discover with the events capability for the right secret and no Origin", async () => {
    await withServer({ eventsMcp }, async base => {
      const res = await fetch(`${base}/mcp/events/${SECRET}`, { method: "POST", headers: MODERN_HEADERS, body: DISCOVER_BODY })
      expect(res.status).toBe(200)
      expect(res.headers.get("cache-control")).toBe("no-store")
      const body = (await res.json()) as { result: { resultType: string; capabilities: Record<string, unknown> } }
      expect(body.result.resultType).toBe("complete")
      expect(body.result.capabilities.events).toBeDefined()
      expect(body.result.capabilities.resources).toBeUndefined()
    })
  })

  it("413s a body over 1 MiB", async () => {
    await withServer({ eventsMcp }, async base => {
      const res = await fetch(`${base}/mcp/events/${SECRET}`, {
        method: "POST",
        headers: MODERN_HEADERS,
        body: "x".repeat(1024 * 1024 + 1),
      })
      expect(res.status).toBe(413)
    })
  })

  it("405s a GET", async () => {
    await withServer({ eventsMcp }, async base => {
      const res = await fetch(`${base}/mcp/events/${SECRET}`, { method: "GET", headers: MODERN_HEADERS })
      expect(res.status).toBe(405)
    })
  })

  it("grants nothing on /mcp: the events secret is not the daemon bearer", async () => {
    await withServer({ eventsMcp, auth: { mode: "bearer", token: DAEMON_TOKEN } }, async base => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { ...MODERN_HEADERS, authorization: `Bearer ${SECRET}`, "x-forwarded-for": "203.0.113.9" },
        body: DISCOVER_BODY,
      })
      expect(res.status).toBe(401)
    })
  })

  it("stays reachable through a tunnel in bearer mode without the daemon bearer", async () => {
    await withServer({ eventsMcp, auth: { mode: "bearer", token: DAEMON_TOKEN } }, async base => {
      const res = await fetch(`${base}/mcp/events/${SECRET}`, {
        method: "POST",
        headers: { ...MODERN_HEADERS, "x-forwarded-for": "203.0.113.9" },
        body: DISCOVER_BODY,
      })
      expect(res.status).toBe(200)
    })
  })

  it("does not exempt /mcp/events/ from the tunnel bearer gate when eventsMcp is absent", async () => {
    await withServer({ auth: { mode: "bearer", token: DAEMON_TOKEN } }, async base => {
      const res = await fetch(`${base}/mcp/events/${SECRET}`, {
        method: "POST",
        headers: { ...MODERN_HEADERS, "x-forwarded-for": "203.0.113.9" },
        body: DISCOVER_BODY,
      })
      expect(res.status).toBe(401)
    })
  })
})

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
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}
