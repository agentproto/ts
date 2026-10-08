/**
 * Pins the MCP 2026-07-28 HTTP contract for the daemon's `/mcp` endpoint.
 *
 * This file keeps the `current behaviour (characterization)` tests: real tests that record what root `/mcp` answers
 * TODAY (2025-11-25 SDK transport, `2026-07-28` header coerced down), so the modern adapter work cannot change root
 * `/mcp` by accident. The 2026-07-28 contract itself is pinned in `mcp-modern-contract-live.test.ts`.
 *
 * Spec fixtures live in `./fixtures/mcp-2026-07-28/` (see its README).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createServer, request as httpRequest } from "node:http"
import type { IncomingHttpHeaders } from "node:http"
import { AddressInfo } from "node:net"
import { readFileSync } from "node:fs"
import { createMcpServer, registerEventsMethods } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

type Json = Record<string, any>

interface Fixture {
  _source: string
  headers?: Record<string, string>
  httpStatus?: number
  body: Json
}

function fixture(name: string): Fixture {
  const raw = readFileSync(new URL(`./fixtures/mcp-2026-07-28/${name}.json`, import.meta.url), "utf8")
  return JSON.parse(raw) as Fixture
}

const DISCOVER_REQUEST = fixture("discover-request")
const TOOLS_CALL_REQUEST = fixture("tools-call-request")
const TOOLS_LIST_RESPONSE = fixture("tools-list-response")
const TOOLS_CALL_RESPONSE = fixture("tools-call-response")
const DISCOVER_RESPONSE = fixture("discover-response")
const ERROR_32020 = fixture("error-32020-header-mismatch")
const ERROR_32022 = fixture("error-32022-unsupported-protocol-version")

const MODERN_VERSION = "2026-07-28"
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "contract-test", version: "0.0.1" },
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

interface Reply {
  status: number
  headers: Headers
  text: string
  /** Parsed JSON-RPC message: the single SSE `data:` line, or the JSON body. `undefined` for an empty body. */
  json: Json | undefined
}

function parseBody(text: string): Json | undefined {
  if (text.length === 0) return undefined
  const dataLine = text.split("\n").find(line => line.startsWith("data:"))
  return JSON.parse(dataLine ? dataLine.slice("data:".length).trim() : text) as Json
}

let baseUrl = ""
let port = 0
let stop: () => Promise<void> = async () => {}

beforeAll(async () => {
  port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
  })
  baseUrl = `http://127.0.0.1:${port}/mcp`
  stop = () => http.stop()
})

afterAll(async () => {
  await stop()
})

async function send(init: RequestInit): Promise<Reply> {
  const res = await fetch(baseUrl, { ...init, signal: AbortSignal.timeout(10_000) })
  const text = await res.text()
  return { status: res.status, headers: res.headers, text, json: parseBody(text) }
}

function rpc(method: string, params: Json | undefined, id: number | string = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })
}

function postHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", accept: ACCEPT, ...extra }
}

/** A well-formed modern POST: spec headers + `_meta` in the body. */
function modernPost(
  method: string,
  params: Json = {},
  headers: Record<string, string> = { "mcp-protocol-version": MODERN_VERSION, "mcp-method": method },
): Promise<Reply> {
  return send({
    method: "POST",
    headers: postHeaders(headers),
    body: rpc(method, { ...params, _meta: MODERN_META }),
  })
}

/**
 * A verb the daemon answers by opening a stream (GET): resolve as soon as the
 * response headers arrive, then drop the connection instead of waiting for a body.
 */
function headersOnly(method: string, headers: Record<string, string>): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/mcp", method, headers }, res => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers })
      req.destroy()
    })
    req.on("error", err => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err)
    })
    req.setTimeout(5000, () => reject(new Error(`no response headers for ${method} /mcp within 5s`)))
    req.end()
  })
}

describe("fixtures are spec-shaped (sanity)", () => {
  it.each([
    ["discover-request", DISCOVER_REQUEST],
    ["tools-call-request", TOOLS_CALL_REQUEST],
    ["tools-list-response", TOOLS_LIST_RESPONSE],
    ["tools-call-response", TOOLS_CALL_RESPONSE],
    ["discover-response", DISCOVER_RESPONSE],
    ["error-32020-header-mismatch", ERROR_32020],
    ["error-32022-unsupported-protocol-version", ERROR_32022],
  ])("%s names its spec source", (_name, fx) => {
    expect(fx._source).toMatch(/^https:\/\/modelcontextprotocol\.io\/specification\/2026-07-28\//)
  })

  it("pins the shapes the contract targets", () => {
    expect(DISCOVER_RESPONSE.body.result).toMatchObject({
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      ttlMs: 3600000,
      cacheScope: "public",
    })
    expect(DISCOVER_RESPONSE.body.result._meta["io.modelcontextprotocol/serverInfo"]).toBeDefined()
    expect(TOOLS_LIST_RESPONSE.body.result).toMatchObject({ resultType: "complete", ttlMs: 300000, cacheScope: "public" })
    expect(TOOLS_CALL_RESPONSE.body.result.resultType).toBe("complete")
    expect(TOOLS_CALL_RESPONSE.body.result).not.toHaveProperty("ttlMs")
    expect(ERROR_32020.body.error.code).toBe(-32020)
    expect(ERROR_32020.httpStatus).toBe(400)
    expect(ERROR_32022.body.error).toMatchObject({ code: -32022, data: { supported: expect.any(Array), requested: "1900-01-01" } })
    expect(ERROR_32022.httpStatus).toBe(400)
  })
})

describe("current behaviour (characterization)", () => {
  // These record what the daemon does on `/mcp` today, which is NOT the 2026-07-28
  // contract. The wrong-per-spec answers are deliberate: P1 must not change root
  // `/mcp` (the adapter is mounted on a new route), so a diff here means root moved.

  describe("modern-era header on a legacy-shaped transport", () => {
    it("tools/list under `MCP-Protocol-Version: 2026-07-28` is coerced and answered in the legacy shape", async () => {
      const r = await modernPost("tools/list")
      expect(r.status).toBe(200)
      expect(r.headers.get("content-type")).toBe("text/event-stream")
      expect(r.json).toMatchObject({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "probe" }] } })
      expect(r.json?.result).not.toHaveProperty("resultType")
      expect(r.json?.result).not.toHaveProperty("ttlMs")
      expect(r.json?.result).not.toHaveProperty("cacheScope")
    })

    it("tools/call (spec fixture headers + `_meta`) executes and answers without `resultType`", async () => {
      const fx = TOOLS_CALL_REQUEST
      const r = await send({
        method: "POST",
        headers: { ...fx.headers, accept: ACCEPT },
        body: JSON.stringify({
          ...fx.body,
          params: { ...fx.body.params, name: "probe", arguments: {} },
        }),
      })
      // `Mcp-Name: get_weather` does not match the body name `probe`: ignored today.
      expect(r.status).toBe(200)
      expect(r.json).toMatchObject({ id: 1, result: { content: [{ type: "text", text: "probe" }] } })
      expect(r.json?.result).not.toHaveProperty("resultType")
    })

    it("events/list answers its payload without `resultType`", async () => {
      const r = await modernPost("events/list")
      expect(r.status).toBe(200)
      expect(r.json?.result).toEqual({ events: [], nextCursor: null })
    })

    it("every POST answer is an SSE stream, never `application/json`", async () => {
      const r = await modernPost("tools/list")
      expect(r.headers.get("content-type")).toBe("text/event-stream")
      expect(r.text).toMatch(/^event: message\ndata: /)
    })

    it("a newer unknown version (2099-01-01) is also coerced down and served", async () => {
      const r = await modernPost("tools/list", {}, { "mcp-protocol-version": "2099-01-01" })
      expect(r.status).toBe(200)
      expect(r.json?.result?.tools).toHaveLength(1)
    })

    it("an unsupported version that is not newer (1900-01-01) is a 400 with legacy `-32000`, `id: null`, no `data`", async () => {
      const r = await modernPost("tools/list", {}, { "mcp-protocol-version": "1900-01-01" })
      expect(r.status).toBe(400)
      expect(r.json?.id).toBeNull()
      expect(r.json?.error.code).toBe(-32000)
      expect(r.json?.error.message).toMatch(/Unsupported protocol version: 1900-01-01/)
      expect(r.json?.error).not.toHaveProperty("data")
    })
  })

  describe("server/discover", () => {
    it("the spec discover request fixture is answered `-32601` inside an HTTP 200 (not a 404)", async () => {
      const r = await send({
        method: "POST",
        headers: postHeaders({ "mcp-protocol-version": MODERN_VERSION, "mcp-method": "server/discover" }),
        body: JSON.stringify(DISCOVER_REQUEST.body),
      })
      expect(r.status).toBe(200)
      expect(r.json).toEqual({ jsonrpc: "2.0", id: "discover-1", error: { code: -32601, message: "Method not found" } })
    })

    it("discover is never answered with a result that advertises `supportedVersions`", async () => {
      const r = await modernPost("server/discover")
      expect(r.json?.result).toBeUndefined()
    })
  })

  describe("headers the 2026-07-28 spec validates are ignored today", () => {
    // Safety net for P1: a missing or mismatched MCP-Protocol-Version, Mcp-Method or Mcp-Name is served with 200
    // on root `/mcp`. The events-only route will reject them (-32020); these tests must keep passing on `/mcp`.
    it("a request without `MCP-Protocol-Version` is served (legacy behaviour), not a 400", async () => {
      const r = await send({ method: "POST", headers: postHeaders(), body: rpc("tools/list", { _meta: MODERN_META }) })
      expect(r.status).toBe(200)
      expect(r.json?.result?.tools).toHaveLength(1)
    })

    it("`MCP-Protocol-Version` that differs from the `_meta` version is served", async () => {
      const r = await modernPost("tools/list", {}, { "mcp-protocol-version": "2025-11-25", "mcp-method": "tools/list" })
      expect(r.status).toBe(200)
      expect(r.json?.result?.tools).toHaveLength(1)
    })

    it("`Mcp-Method` that differs from the body `method` is served", async () => {
      const r = await modernPost("tools/list", {}, { "mcp-protocol-version": MODERN_VERSION, "mcp-method": "tools/call" })
      expect(r.status).toBe(200)
      expect(r.json?.result?.tools).toHaveLength(1)
    })

    it("a tools/call with a missing or different `Mcp-Name` is executed", async () => {
      const base = { "mcp-protocol-version": MODERN_VERSION, "mcp-method": "tools/call" }
      const missing = await modernPost("tools/call", { name: "probe", arguments: {} }, base)
      const different = await modernPost("tools/call", { name: "probe", arguments: {} }, { ...base, "mcp-name": "other" })
      for (const r of [missing, different]) {
        expect(r.status).toBe(200)
        expect(r.json?.result?.content).toEqual([{ type: "text", text: "probe" }])
      }
    })

    it("an unknown method is an HTTP 200 carrying `-32601` (the spec asks for HTTP 404)", async () => {
      const r = await modernPost("nope/nothing")
      expect(r.status).toBe(200)
      expect(r.json?.error?.code).toBe(-32601)
    })

    it("header names are matched case-insensitively", async () => {
      const r = await send({
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: ACCEPT, "MCP-Protocol-Version": MODERN_VERSION, "MCP-METHOD": "tools/list" },
        body: rpc("tools/list", { _meta: MODERN_META }),
      })
      expect(r.status).toBe(200)
      expect(r.json?.result?.tools).toHaveLength(1)
    })

    it("a duplicated `MCP-Protocol-Version` is joined by the HTTP stack and coerced, not rejected", async () => {
      const headers = new Headers(postHeaders())
      headers.append("mcp-protocol-version", MODERN_VERSION)
      headers.append("mcp-protocol-version", "2025-11-25")
      const r = await send({ method: "POST", headers, body: rpc("tools/list", { _meta: MODERN_META }) })
      expect(r.status).toBe(200)
      expect(r.json?.result?.tools).toHaveLength(1)
    })
  })

  describe("verbs and session headers", () => {
    it("GET with `Accept: text/event-stream` opens an idle 200 SSE stream (the spec asks for 405)", async () => {
      const r = await headersOnly("GET", { accept: "text/event-stream", "mcp-protocol-version": MODERN_VERSION })
      expect(r.status).toBe(200)
      expect(r.headers["content-type"]).toBe("text/event-stream")
    })

    it("GET without `text/event-stream` in `Accept` is a 406", async () => {
      const r = await headersOnly("GET", { accept: "application/json" })
      expect(r.status).toBe(406)
    })

    it("DELETE is a 200 with an empty body (the spec asks for 405)", async () => {
      const r = await send({ method: "DELETE", headers: { "mcp-protocol-version": MODERN_VERSION } })
      expect(r.status).toBe(200)
      expect(r.text).toBe("")
    })

    it("DELETE with an `Mcp-Session-Id` is still a 200", async () => {
      const r = await send({ method: "DELETE", headers: { "mcp-protocol-version": MODERN_VERSION, "mcp-session-id": "abc" } })
      expect(r.status).toBe(200)
    })

    it("HEAD is a 405 whose `Allow` lists GET, POST, DELETE", async () => {
      const r = await send({ method: "HEAD" })
      expect(r.status).toBe(405)
      expect(r.headers.get("allow")).toBe("GET, POST, DELETE")
    })

    it("OPTIONS is a 204 answered by the CORS layer before routing", async () => {
      const r = await send({ method: "OPTIONS" })
      expect(r.status).toBe(204)
      expect(r.headers.get("access-control-allow-methods")).toBe("GET,POST,PUT,PATCH,DELETE,OPTIONS")
    })

    it("a request `Mcp-Session-Id` is ignored and no session id is minted or echoed", async () => {
      const r = await modernPost("tools/list", {}, { "mcp-protocol-version": MODERN_VERSION, "mcp-method": "tools/list", "mcp-session-id": "abc" })
      expect(r.status).toBe(200)
      expect(r.headers.get("mcp-session-id")).toBeNull()
    })

    it("a legacy `initialize` is answered at 2025-11-25 without minting an `Mcp-Session-Id`", async () => {
      const r = await send({
        method: "POST",
        headers: postHeaders({ "mcp-protocol-version": "2025-11-25" }),
        body: rpc("initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "contract-test", version: "0.0.1" },
        }),
      })
      expect(r.status).toBe(200)
      expect(r.json?.result).toMatchObject({ protocolVersion: "2025-11-25", serverInfo: { name: "main" } })
      expect(r.json?.result.capabilities).toHaveProperty("events")
      expect(r.headers.get("mcp-session-id")).toBeNull()
    })

    it("a request `Last-Event-ID` is ignored", async () => {
      const r = await modernPost("tools/list", {}, { "mcp-protocol-version": MODERN_VERSION, "last-event-id": "5" })
      expect(r.status).toBe(200)
      expect(r.json?.result?.tools).toHaveLength(1)
    })
  })

  describe("body and content handling", () => {
    it("an untrusted `Origin` is a 403 `mcp_forbidden_origin` (a non-JSON-RPC body), on POST and GET", async () => {
      const post = await modernPost("tools/list", {}, { "mcp-protocol-version": MODERN_VERSION, origin: "https://evil.example" })
      expect(post.status).toBe(403)
      expect(post.json).toMatchObject({ error: "mcp_forbidden_origin" })
      const get = await send({ method: "GET", headers: { origin: "https://evil.example" } })
      expect(get.status).toBe(403)
    })

    it("malformed JSON is a 400 with `-32700` and `id: null`", async () => {
      const r = await send({ method: "POST", headers: postHeaders({ "mcp-protocol-version": MODERN_VERSION }), body: "{not json" })
      expect(r.status).toBe(400)
      expect(r.json).toEqual({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: Invalid JSON" }, id: null })
    })

    it("a body over 4194304 bytes is a 413 with `-32000`", async () => {
      const big = rpc("tools/call", { name: "probe", arguments: { filler: "a".repeat(4_194_304 + 1024) } })
      const r = await send({ method: "POST", headers: postHeaders({ "mcp-protocol-version": MODERN_VERSION }), body: big })
      expect(r.status).toBe(413)
      expect(r.json?.error).toMatchObject({ code: -32000 })
      expect(r.json?.error.message).toMatch(/must not exceed 4194304 bytes/)
    })

    it("a notification (no `id`) is a 202 with an empty body", async () => {
      const r = await send({
        method: "POST",
        headers: postHeaders({ "mcp-protocol-version": MODERN_VERSION }),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      })
      expect(r.status).toBe(202)
      expect(r.text).toBe("")
    })

    it("`Accept` without both `application/json` and `text/event-stream` is a 406 with `-32000`", async () => {
      for (const accept of [undefined, "application/json"]) {
        const headers: Record<string, string> = { "content-type": "application/json", "mcp-protocol-version": MODERN_VERSION }
        if (accept) headers["accept"] = accept
        const r = await send({ method: "POST", headers, body: rpc("tools/list", { _meta: MODERN_META }) })
        expect(r.status, `accept=${accept}`).toBe(406)
        expect(r.json?.error.code).toBe(-32000)
      }
    })

    it("a `Content-Type` other than `application/json` is a 415 with `-32000`", async () => {
      const r = await send({
        method: "POST",
        headers: { "content-type": "text/plain", accept: ACCEPT, "mcp-protocol-version": MODERN_VERSION },
        body: rpc("tools/list", { _meta: MODERN_META }),
      })
      expect(r.status).toBe(415)
      expect(r.json?.error.code).toBe(-32000)
    })
  })
})

// The "modern contract" and "local policy" rows that used to be `test.todo` here now run for real, through
// `handleModernRequest`, in `mcp-modern-contract-live.test.ts`. Rows deliberately NOT carried over:
//  - `-32021` (undeclared required client capability): the events-only server declares no required-capability checks.
//  - "a notification the server refuses gets a 4xx": notifications are accepted with 202 (spec-legal, SPEC-NOTES Q2).
// HTTP-level rows are covered by `mcp-events-route.test.ts`: untrusted/absent `Origin` (403 even with a valid bearer;
// absent allowed), the request body size cap (413), and OPTIONS/HEAD/GET/DELETE answering 405 with `Allow: POST`.
