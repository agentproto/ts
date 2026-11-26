import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createServer, request as httpRequest } from "node:http"
import type { IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer, registerEventsMethods } from "@agentproto/mcp-server"

import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createMcpObservationStore } from "../mcp-session-observer.js"
import { GATEWAY_ADVERTISED_VERSIONS, MODERN_PROTOCOL_VERSION } from "../mcp-modern/index.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

type Json = Record<string, any>

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "gateway-test", version: "0.0.1" },
  "io.modelcontextprotocol/clientCapabilities": {},
}
const ACCEPT = "application/json, text/event-stream"

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

async function defaultMcpFactory(
  denyTools?: ReadonlySet<string>,
  _callerSessionId?: string,
  _origin?: string,
  deferred?: boolean,
  allowTools?: ReadonlySet<string>,
) {
  const { server } = await createMcpServer({ specs: [], name: "gateway-test", version: "1.0.0" })
  const allTools: Array<{ name: string; text: string }> = deferred
    ? [{ name: "tool_search", text: "deferred-search" }]
    : [
        { name: "probe", text: "probe-ok" },
        { name: "alpha", text: "alpha-ok" },
        { name: "secret_tool", text: "secret-ok" },
      ]
  const deny = denyTools ?? new Set<string>()
  const allow = allowTools && allowTools.size > 0 ? allowTools : undefined
  for (const t of allTools) {
    if (allow && !allow.has(t.name)) continue
    if (deny.has(t.name)) continue
    server.tool(t.name, `${t.name} tool`, {}, async () => ({
      content: [{ type: "text", text: t.text }],
    }))
  }
  registerEventsMethods(server, {
    list: async () => ({ events: [], nextCursor: null }),
    subscribe: async () => ({ id: "sub_1", refreshBefore: null, cursor: null }),
    unsubscribe: async () => ({}),
  })
  return server
}

function parseReplyBody(text: string): Json | undefined {
  if (!text) return undefined
  const dataLine = text.split("\n").find(line => line.startsWith("data:"))
  return JSON.parse(dataLine ? dataLine.slice("data:".length).trim() : text) as Json
}

function headersOnly(
  port: number,
  path: string,
  method: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, res => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers })
      req.destroy()
    })
    req.on("error", err => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err)
    })
    req.setTimeout(5000, () => reject(new Error(`timeout for ${method} ${path}`)))
    req.end()
  })
}

async function withGateway(
  overrides: Partial<RuntimeHttpServerOptions>,
  fn: (ctx: { port: number; url: (path?: string) => string }) => Promise<void>,
): Promise<void> {
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory: defaultMcpFactory,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
    ...overrides,
  })
  try {
    await fn({ port, url: (path = "/mcp") => `http://127.0.0.1:${port}${path}` })
  } finally {
    await http.stop()
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, text, json: parseReplyBody(text) }
}

function modernRpc(
  url: string,
  method: string,
  params: Json = {},
  extraHeaders: Record<string, string> = {},
  meta: Json = MODERN_META,
) {
  return postJson(
    url,
    { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } },
    {
      "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
      "mcp-method": method,
      ...extraHeaders,
    },
  )
}

describe("modern MCP 2026-07-28 gateway on /mcp", () => {
  let port = 0
  let stop: () => Promise<void> = async () => {}
  const observations = createMcpObservationStore()
  const url = (path = "/mcp") => `http://127.0.0.1:${port}${path}`

  beforeAll(async () => {
    port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: defaultMcpFactory,
      mcpObservations: observations,
      mcpModern: { enabled: true, extensions: {} },
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    stop = () => http.stop()
  })

  afterAll(async () => {
    await stop()
  })

  it("serves server/discover on loopback without Bearer with dual-era advertisedVersions", async () => {
    const r = await modernRpc(url(), "server/discover")
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toBe("application/json")
    expect(r.json?.result).toMatchObject({
      resultType: "complete",
      supportedVersions: [...GATEWAY_ADVERTISED_VERSIONS],
      ttlMs: 0,
      cacheScope: "private",
    })
    expect(r.json?.result?.capabilities?.tools).toBeDefined()
    expect(r.json?.result?.capabilities?.logging).toBeUndefined()
    expect(r.json?.result?.capabilities?.extensions).toEqual({})
    expect(r.json?.result?._meta?.["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "gateway-test",
      version: "1.0.0",
    })
  })

  it("enforces Bearer auth and Origin checks before modern routing", async () => {
    await withGateway({ auth: { mode: "bearer", token: "tok-secret" } }, async gw => {
      // Proxied (non-loopback) request requires Bearer token.
      const noAuth = await modernRpc(gw.url(), "server/discover", {}, { "x-forwarded-for": "203.0.113.10" })
      expect(noAuth.status).toBe(401)

      const withAuth = await modernRpc(
        gw.url(),
        "server/discover",
        {},
        { "x-forwarded-for": "203.0.113.10", authorization: "Bearer tok-secret" },
      )
      expect(withAuth.status).toBe(200)
      expect(withAuth.json?.result?.supportedVersions).toEqual([...GATEWAY_ADVERTISED_VERSIONS])

      // Untrusted browser Origin is refused 403 without Bearer, accepted with Bearer.
      const badOrigin = await modernRpc(gw.url(), "server/discover", {}, { origin: "https://evil.example" })
      expect(badOrigin.status).toBe(403)

      const badOriginWithBearer = await modernRpc(
        gw.url(),
        "server/discover",
        {},
        { origin: "https://evil.example", authorization: "Bearer tok-secret" },
      )
      expect(badOriginWithBearer.status).toBe(200)
    })
  })

  it("returns the exact same tool names on modern tools/list and legacy tools/list", async () => {
    const modern = await modernRpc(url(), "tools/list")
    expect(modern.status).toBe(200)
    expect(modern.json?.result?.resultType).toBe("complete")
    const modernNames = (modern.json?.result?.tools as Array<{ name: string }>).map(t => t.name)

    const legacy = await postJson(
      url(),
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { "mcp-protocol-version": "2025-11-25" },
    )
    expect(legacy.status).toBe(200)
    expect(legacy.headers.get("content-type")).toBe("text/event-stream")
    const legacyNames = (legacy.json?.result?.tools as Array<{ name: string }>).map(t => t.name)

    expect(modernNames).toEqual(legacyNames)
    expect(modernNames).toEqual(["probe", "alpha", "secret_tool"])
  })

  it("executes tools/call in modern mode and respects ?denyTools=, ?allowTools= and ?deferred=1", async () => {
    const call = await modernRpc(url(), "tools/call", { name: "probe", arguments: {} }, { "mcp-name": "probe" })
    expect(call.status).toBe(200)
    expect(call.json?.result?.resultType).toBe("complete")
    expect(call.json?.result?.content).toEqual([{ type: "text", text: "probe-ok" }])
    expect(call.json?.result).not.toHaveProperty("ttlMs")

    const denied = await modernRpc(url("/mcp?denyTools=secret_tool"), "tools/list")
    expect((denied.json?.result?.tools as Array<{ name: string }>).map(t => t.name)).toEqual(["probe", "alpha"])

    const allowed = await modernRpc(url("/mcp?allowTools=alpha"), "tools/list")
    expect((allowed.json?.result?.tools as Array<{ name: string }>).map(t => t.name)).toEqual(["alpha"])

    const deferred = await modernRpc(url("/mcp?deferred=1"), "tools/list")
    expect((deferred.json?.result?.tools as Array<{ name: string }>).map(t => t.name)).toEqual(["tool_search"])
  })

  it("does not downgrade MCP-Protocol-Version: 2026-07-28 and rejects mismatched headers (-32020) and unknown versions (-32022)", async () => {
    const badName = await modernRpc(url(), "tools/call", { name: "probe", arguments: {} }, { "mcp-name": "alpha" })
    expect(badName.status).toBe(400)
    expect(badName.json?.error?.code).toBe(-32020)

    const unknownVer = await postJson(
      url(),
      {
        jsonrpc: "2.0",
        id: 3,
        method: "server/discover",
        params: { _meta: { ...MODERN_META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } },
      },
      { "mcp-protocol-version": "1900-01-01", "mcp-method": "server/discover" },
    )
    expect(unknownVer.status).toBe(400)
    expect(unknownVer.json?.error?.code).toBe(-32022)
    expect(unknownVer.json?.error?.data).toEqual({
      supported: [...GATEWAY_ADVERTISED_VERSIONS],
      requested: "1900-01-01",
    })
  })

  describe("routing and fallback matrix", () => {
    it("POST without header + initialize body routes to legacy with parsedBody intact", async () => {
      const r = await postJson(url(), {
        jsonrpc: "2.0",
        id: 10,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "1.0.0" },
        },
      })
      expect(r.status).toBe(200)
      expect(r.headers.get("content-type")).toBe("text/event-stream")
      expect(r.json?.result?.protocolVersion).toBe("2025-11-25")
      expect(r.json?.result).not.toHaveProperty("resultType")
    })

    it("rejects modern request carrying 2025-11-25 in BOTH header and _meta with -32022 (advertisedVersions does not widen accepted versions)", async () => {
      for (const method of ["server/discover", "tools/list"]) {
        const r = await postJson(
          url(),
          {
            jsonrpc: "2.0",
            id: 11,
            method,
            params: { _meta: { ...MODERN_META, "io.modelcontextprotocol/protocolVersion": "2025-11-25" } },
          },
          { "mcp-protocol-version": "2025-11-25", "mcp-method": method },
        )
        expect(r.status, method).toBe(400)
        expect(r.json?.error?.code, method).toBe(-32022)
        expect(r.json?.error?.data, method).toEqual({
          supported: [...GATEWAY_ADVERTISED_VERSIONS],
          requested: "2025-11-25",
        })
      }
    })

    it("POST without header + server/discover body (with _meta) routes to modern (400 -32020, not legacy -32601)", async () => {
      const r = await postJson(url(), {
        jsonrpc: "2.0",
        id: 12,
        method: "server/discover",
        params: { _meta: MODERN_META },
      })
      expect(r.status).toBe(400)
      expect(r.json?.error?.code).toBe(-32020)
    })

    it("invalid JSON body returns 400 -32700 with id null", async () => {
      const r = await postJson(url(), "{broken-json")
      expect(r.status).toBe(400)
      expect(r.json).toEqual({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error: Invalid JSON" },
        id: null,
      })
    })

    it("POST with header 2025-11-25 and _meta 2026-07-28 is refused by modern (-32020), never silently accepted", async () => {
      const r = await postJson(
        url(),
        {
          jsonrpc: "2.0",
          id: 13,
          method: "tools/list",
          params: { _meta: MODERN_META },
        },
        { "mcp-protocol-version": "2025-11-25", "mcp-method": "tools/list" },
      )
      expect(r.status).toBe(400)
      expect(r.json?.error?.code).toBe(-32020)
    })

    it("GET and DELETE with modern header return 405 Allow: POST; legacy GET/DELETE stay intact", async () => {
      const modernGet = await headersOnly(port, "/mcp", "GET", {
        accept: "text/event-stream",
        "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
      })
      expect(modernGet.status).toBe(405)
      expect(modernGet.headers["allow"]).toBe("POST")

      const modernDel = await fetch(url(), {
        method: "DELETE",
        headers: { "mcp-protocol-version": MODERN_PROTOCOL_VERSION },
      })
      expect(modernDel.status).toBe(405)
      expect(modernDel.headers.get("allow")).toBe("POST")

      const legacyGet = await headersOnly(port, "/mcp", "GET", {
        accept: "text/event-stream",
        "mcp-protocol-version": "2025-11-25",
      })
      expect(legacyGet.status).toBe(200)
      expect(legacyGet.headers["content-type"]).toBe("text/event-stream")

      const legacyDel = await fetch(url(), {
        method: "DELETE",
        headers: { "mcp-protocol-version": "2025-11-25" },
      })
      expect(legacyDel.status).toBe(200)
    })
  })

  it("feeds mcpObservations for modern discover, tools/list, and HTTP errors", async () => {
    const sid = "sess_modern_obs"
    const discover = await modernRpc(url(`/mcp?callerSessionId=${sid}`), "server/discover")
    expect(discover.status).toBe(200)
    const list = await modernRpc(url(`/mcp?callerSessionId=${sid}`), "tools/list")
    expect(list.status).toBe(200)

    const obs = observations.get(sid)
    expect(obs?.discover?.ok).toBe(true)
    expect(obs?.discover?.protocolVersion).toBe(MODERN_PROTOCOL_VERSION)
    expect(obs?.toolsList?.ok).toBe(true)
    expect(obs?.toolsList?.toolCount).toBe(3)
    expect(obs?.toolsList?.protocolVersion).toBe(MODERN_PROTOCOL_VERSION)

    const sidErr = "sess_modern_err"
    const bad = await modernRpc(url(`/mcp?callerSessionId=${sidErr}`), "tools/list", {}, { "mcp-method": "tools/call" })
    expect(bad.status).toBe(400)
    expect(observations.get(sidErr)?.httpError?.status).toBe(400)
  })

  it("falls back completely to legacy routing when mcpModern.enabled is false", async () => {
    await withGateway({ mcpModern: { enabled: false } }, async gw => {
      const r = await modernRpc(gw.url(), "server/discover")
      expect(r.status).toBe(200)
      expect(r.headers.get("content-type")).toBe("text/event-stream")
      expect(r.json?.error?.code).toBe(-32601)

      const list = await modernRpc(gw.url(), "tools/list")
      expect(list.status).toBe(200)
      expect(list.headers.get("content-type")).toBe("text/event-stream")
      expect(list.json?.result).not.toHaveProperty("resultType")
    })
  })

  it("supports a full 2026-07-28 client flow: discover -> tools/list -> tools/call", async () => {
    const discover = await modernRpc(url(), "server/discover")
    expect(discover.status).toBe(200)
    expect(discover.json?.result?.supportedVersions).toContain(MODERN_PROTOCOL_VERSION)

    const list = await modernRpc(url(), "tools/list")
    expect(list.status).toBe(200)
    const tools = list.json?.result?.tools as Array<{ name: string }>
    expect(tools.some(t => t.name === "alpha")).toBe(true)

    const call = await modernRpc(url(), "tools/call", { name: "alpha", arguments: {} }, { "mcp-name": "alpha" })
    expect(call.status).toBe(200)
    expect(call.json?.result?.resultType).toBe("complete")
    expect(call.json?.result?.content).toEqual([{ type: "text", text: "alpha-ok" }])
  })
})
