/**
 * Pins the MCP 2026-07-28 HTTP contract for the daemon's `/mcp` endpoint.
 *
 * Three blocks:
 *  - `current behaviour (characterization)`: real tests that record what `/mcp`
 *    answers TODAY (2025-11-25 SDK transport, `2026-07-28` header coerced down),
 *    so the modern adapter work cannot change root `/mcp` by accident.
 *  - `modern contract (target for P1)`: one `test.todo` per row the spec text
 *    settles, to be flipped by the adapter.
 *  - `local policy (decided 2026-10-08)`: `test.todo` rows the spec leaves open
 *    (or only SHOULDs); our own decisions for the events-only route.
 *
 * Spec fixtures live in `./fixtures/mcp-2026-07-28/` (see its README).
 */

import { describe, it, test, expect, beforeAll, afterAll } from "vitest"
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

describe("modern contract (target for P1)", () => {
  // Every case below is mounted on the P1 events-only route (`/mcp/events`), never on root `/mcp`.
  // Rows here are settled by the 2026-07-28 spec text (see SPEC-NOTES.md); P1 flips each to a real test.
  // Spec pages: https://modelcontextprotocol.io/specification/2026-07-28/
  //   basic/transports/streamable-http, basic/versioning, basic/index,
  //   server/discover, server/tools, server/utilities/caching
  // The "headers the 2026-07-28 spec validates are ignored today" characterization tests above are the
  // safety net for the validation rows below: when P1 rejects them on the new route, root `/mcp` must keep serving them.

  describe("result shapes", () => {
    // Fixtures: discover-response, tools-list-response, tools-call-response
    test.todo("discover result shape (supportedVersions, capabilities, serverInfo, resultType, ttlMs, cacheScope)")
    test.todo("`events` is declared top-level in discover `capabilities` (capabilities.events, not capabilities.extensions)")
    test.todo("tools/list carries resultType+ttlMs+cacheScope")
    test.todo("tools/list returns tools in a stable order across consecutive requests")
    test.todo("tools/call carries resultType and no ttlMs or cacheScope")
    // No events/* page exists in the 2026-07-28 spec index; the generic rule
    // "every result carries resultType" (basic/index) pins these rows.
    test.todo("events/list|subscribe|unsubscribe carry resultType \"complete\" and no ttlMs or cacheScope")
    test.todo("events/unsubscribe returns `{}` plus resultType (not `{ ok: true }`)")
    test.todo("a result's `resultType` is \"complete\" or \"input_required\", never absent")
  })

  describe("request validation", () => {
    // spec: streamable-http 'Protocol Version Header' and 'Server Validation'.
    // The spec lets a server that still serves pre-2025-06-18 clients treat a missing header as
    // 2025-03-26; this route does not take that branch, so a missing header is rejected.
    test.todo("missing MCP-Protocol-Version header (`-32020`, HTTP 400)")
    test.todo("header differs from `_meta` version (`-32020`, HTTP 400)")
    test.todo("`Mcp-Method` missing or different from `method` (`-32020`, HTTP 400)")
    test.todo("`Mcp-Method` value is case-sensitive (`TOOLS/LIST` is `-32020`, HTTP 400)")
    test.todo("`Mcp-Name` missing or different on `tools/call` (`-32020`, HTTP 400)")
    test.todo("`Mcp-Name` missing or different on `resources/read` and `prompts/get` (`-32020`, HTTP 400)")
    test.todo("`Mcp-Name` Base64 sentinel `=?base64?...?=` is decoded before comparison with params.name")
    test.todo("`Mcp-Name` plain ASCII value that looks like the sentinel (`=?base64?...?=`) is compared as-is and mismatches (`-32020`)")
    test.todo("optional whitespace around `Mcp-Name` and `Mcp-Method` values is trimmed (RFC 9110 5.5)")
    test.todo("header names are case-insensitive")
    test.todo("unsupported version (`-32022`, HTTP 400, `data.supported` and `data.requested`)")
    test.todo("`-32022` `data.supported` is a non-empty subset of discover `supportedVersions` (one shared constant)")
    test.todo("missing required `_meta` field (`-32602`, HTTP 400) for `protocolVersion` and for `clientCapabilities`")
    test.todo("missing `_meta` entirely (`-32602`, HTTP 400)")
    test.todo("`io.modelcontextprotocol/clientInfo` is optional (request without it is served, HTTP 200)")
    test.todo("required client capability not declared (`-32021`, HTTP 400, `data.requiredCapabilities`)")
    test.todo("unknown method (HTTP 404, `-32601`)")
    test.todo("removed legacy methods `initialize`, `ping`, `logging/setLevel`, `resources/subscribe`, `resources/unsubscribe` (HTTP 404, `-32601`)")
    test.todo("a JSON-RPC error response carries the request `id`")
  })

  describe("transport", () => {
    // spec: streamable-http 'Backward Compatibility' > 'Earlier Streamable HTTP Revisions' (GET/DELETE 405 is a SHOULD)
    test.todo("GET and DELETE (405)")
    test.todo("`Mcp-Session-Id` and `Last-Event-ID` ignored; no `Mcp-Session-Id` response header")
    test.todo("untrusted `Origin` present (403, even with a valid bearer)")
    test.todo("notification without `id` that the server accepts (202 Accepted, no body)")
    test.todo("a notification the server refuses gets a 4xx, optionally with a JSON-RPC error without `id`")
    test.todo("response `Content-Type` is `application/json` or `text/event-stream`")
    test.todo("the POST body is a single JSON-RPC request or notification, never a response")
  })

  describe("caching hints", () => {
    // spec: server/utilities/caching. Hints are required ONLY on results with resultType "complete" from
    // server/discover, tools/list, prompts/list, resources/list, resources/templates/list, resources/read.
    // tools/call, prompts/get and events/* carry none (the plan's "ttlMs 0 for tools/call" is dropped: absent is the spec shape).
    test.todo("ttlMs and cacheScope are present on server/discover, tools/list, prompts/list, resources/list, resources/templates/list and resources/read")
    test.todo("ttlMs and cacheScope are absent on tools/call, prompts/get and events/*")
    test.todo("`ttlMs` is an integer >= 0")
    test.todo("`cacheScope` accepts only \"public\" or \"private\"")
    test.todo("all pages of one paginated list share the same `cacheScope`")
    test.todo("an `input_required` result carries no caching hints")
  })
})

describe("local policy (decided 2026-10-08)", () => {
  // The spec is silent on these (SPEC-NOTES.md), or only says SHOULD. They are OUR decisions for the P1 events-only
  // route, with no upstream conformance oracle; P1 flips them to real tests.

  describe("verbs", () => {
    // Today OPTIONS is a 204 from the CORS layer before routing and GET opens an idle 200 SSE stream
    // (both pinned in "verbs and session headers" above). The events-only route must override both.
    test.todo("OPTIONS is 405 with `Allow: POST` (the CORS layer's 204 must not answer it)")
    test.todo("HEAD is 405 with `Allow: POST`")
    test.todo("GET is 405 with `Allow: POST` (no idle SSE stream)")
    test.todo("DELETE is 405 with `Allow: POST`")
  })

  describe("content negotiation and body", () => {
    test.todo("missing or wrong `Accept` is 406")
    test.todo("`Content-Type` other than application/json is 415")
    test.todo("malformed JSON is 400 with `-32700` and `id: null`")
    test.todo("a JSON-RPC response body or a batch body is 400 with `-32600`")
    test.todo("a body over the size limit is 413 (keeps today's behaviour; the spec defines no limit)")
  })

  describe("origin and auth", () => {
    test.todo("an ABSENT `Origin` stays allowed (non-browser clients carry none)")
    test.todo("an invalid `Origin` is 403 even when the bearer token is valid")
  })

  describe("headers and metadata", () => {
    test.todo("request `_meta` is not echoed into results")
    test.todo("header requirements on a notification POST are not enforced (the spec leaves them undefined)")
    // Neither the spec nor SPEC-NOTES.md decides repeated headers; P1 picks reject vs first-wins. Today they are joined and coerced.
    test.todo("duplicate MCP-Protocol-Version, Mcp-Method or Mcp-Name values (spec silent; policy for P1 to choose)")
  })
})
