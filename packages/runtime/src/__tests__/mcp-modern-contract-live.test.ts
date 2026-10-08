/**
 * Live version of the MCP 2026-07-28 contract rows that `mcp-modern-contract.test.ts` once held as `test.todo`.
 * Every case runs through `handleModernRequest` against a real `McpServer` (tools, a resource, a template, a prompt and
 * the events methods). Test titles repeat the original todo text. Answers come from SPEC-NOTES; HTTP-level rows
 * (Origin, body cap, OPTIONS) are covered by `mcp-events-route.test.ts`.
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { createMcpServer, registerEventsMethods } from "@agentproto/mcp-server"

import { handleModernRequest, type ModernDeps } from "../mcp-modern/index.js"

type Json = Record<string, any>
type Headers = Record<string, string | string[] | undefined>

function fixture(name: string): { _source: string; httpStatus?: number; body: Json } {
  return JSON.parse(readFileSync(new URL(`./fixtures/mcp-2026-07-28/${name}.json`, import.meta.url), "utf8"))
}
const DISCOVER_RESPONSE = fixture("discover-response")
const TOOLS_LIST_RESPONSE = fixture("tools-list-response")
const TOOLS_CALL_RESPONSE = fixture("tools-call-response")
const ERROR_32020 = fixture("error-32020-header-mismatch")
const ERROR_32022 = fixture("error-32022-unsupported-protocol-version")

const VERSION = "2026-07-28"
const META_KEY = "io.modelcontextprotocol/protocolVersion"
const CAPS_KEY = "io.modelcontextprotocol/clientCapabilities"
const INFO_KEY = "io.modelcontextprotocol/clientInfo"
const META = { [META_KEY]: VERSION, [INFO_KEY]: { name: "contract-test", version: "0.0.1" }, [CAPS_KEY]: {} }
const ACCEPT = "application/json, text/event-stream"
const SIX_CACHEABLE = ["server/discover", "tools/list", "prompts/list", "resources/list", "resources/templates/list", "resources/read"]

async function legacyServer(): Promise<McpServer> {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "1.2.3" })
  server.tool("probe", "probe tool", {}, async () => ({ content: [{ type: "text", text: "probe" }] }))
  server.tool("alpha", "alpha tool", {}, async () => ({ content: [{ type: "text", text: "alpha" }] }))
  server.resource("res", "file:///r.txt", async () => ({ contents: [{ uri: "file:///r.txt", text: "x" }] }))
  server.resource("tpl", new ResourceTemplate("file:///t/{id}", { list: undefined }), async (uri) => ({
    contents: [{ uri: uri.href, text: "t" }],
  }))
  server.prompt("pr", async () => ({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] }))
  registerEventsMethods(server, {
    list: async () => ({ events: [], nextCursor: null }),
    subscribe: async () => ({ id: "sub_1", refreshBefore: null, cursor: null }),
    unsubscribe: async () => ({}),
  })
  return server
}

const DEPS: ModernDeps = { createServer: legacyServer }

function headersFor(method: string, over: Headers = {}): Headers {
  const out: Headers = { "content-type": "application/json", accept: ACCEPT, "mcp-protocol-version": VERSION, "mcp-method": method }
  for (const [key, value] of Object.entries(over)) {
    for (const existing of Object.keys(out)) if (existing.toLowerCase() === key.toLowerCase()) delete out[existing]
    if (value !== undefined) out[key] = value
  }
  return out
}

interface CallOpts {
  headers?: Headers
  meta?: Json | null
  id?: string | number
  body?: string
  verb?: string
  deps?: ModernDeps
}

function call(method: string, params: Json = {}, opts: CallOpts = {}) {
  const id = opts.id ?? 1
  const meta = opts.meta === undefined ? META : opts.meta
  const body = opts.body ?? JSON.stringify({ jsonrpc: "2.0", id, method, params: meta === null ? params : { ...params, _meta: meta } })
  return handleModernRequest({ method: opts.verb ?? "POST", headers: headersFor(method, opts.headers), body }, opts.deps ?? DEPS)
}

const json = (r: { body?: string }) => JSON.parse(r.body ?? "null") as { id: unknown; result?: Json; error?: { code: number; message: string; data?: any } }

function callTool(headers: Headers = {}, name = "probe", opts: CallOpts = {}) {
  return call("tools/call", { name, arguments: {} }, { ...opts, headers: { "mcp-name": name, ...headers } })
}

function expectError(r: { status: number; body?: string }, status: number, code: number) {
  expect(r.status).toBe(status)
  expect(json(r).error?.code).toBe(code)
}

function serverWithTools(count: number, override?: (server: McpServer) => void): ModernDeps {
  return {
    createServer: async () => {
      const { server } = await createMcpServer({ specs: [], name: "main", version: "1.2.3" })
      for (let i = 0; i < count; i++) server.tool(`t${i}`, `tool ${i}`, {}, async () => ({ content: [{ type: "text", text: "x" }] }))
      override?.(server)
      return server
    },
  }
}

describe("modern contract (live)", () => {
  describe("result shapes", () => {
    it("discover result shape (supportedVersions, capabilities, serverInfo, resultType, ttlMs, cacheScope)", async () => {
      const r = await call("server/discover")
      expect(r.status).toBe(200)
      const body = json(r)
      expect(body.id).toBe(1)
      expect(body.result).toMatchObject({ resultType: "complete", supportedVersions: [VERSION], ttlMs: expect.any(Number) })
      expect(["public", "private"]).toContain(body.result?.cacheScope)
      expect(body.result?.capabilities).toEqual(expect.objectContaining({ tools: expect.anything() }))
      expect(body.result?._meta?.["io.modelcontextprotocol/serverInfo"]).toEqual({ name: "main", version: "1.2.3" })
      const fixtureKeys = Object.keys(DISCOVER_RESPONSE.body.result)
      for (const key of Object.keys(body.result ?? {})) expect(fixtureKeys).toContain(key)
    })

    it("`events` is declared top-level in discover `capabilities` (capabilities.events, not capabilities.extensions)", async () => {
      const capabilities = json(await call("server/discover")).result?.capabilities
      expect(capabilities?.events).toBeDefined()
      expect(capabilities?.extensions?.["io.modelcontextprotocol/events"]).toBeUndefined()
    })

    it("tools/list carries resultType+ttlMs+cacheScope", async () => {
      const result = json(await call("tools/list")).result
      expect(result).toMatchObject({ resultType: "complete", ttlMs: expect.any(Number) })
      expect(["public", "private"]).toContain(result?.cacheScope)
      expect(Object.keys(TOOLS_LIST_RESPONSE.body.result)).toEqual(expect.arrayContaining(["resultType", "ttlMs", "cacheScope"]))
      expect(result?.tools[0]).toMatchObject({ name: "probe", inputSchema: expect.any(Object) })
    })

    it("tools/list returns tools in a stable order across consecutive requests", async () => {
      const names = async () => json(await call("tools/list")).result?.tools.map((t: { name: string }) => t.name)
      const first = await names()
      expect(first).toEqual(["probe", "alpha"])
      expect(await names()).toEqual(first)
      expect(await names()).toEqual(first)
    })

    it("tools/call carries resultType and no ttlMs or cacheScope", async () => {
      const result = json(await callTool()).result
      expect(result?.resultType).toBe(TOOLS_CALL_RESPONSE.body.result.resultType)
      expect(result?.content).toEqual([{ type: "text", text: "probe" }])
      expect(result).not.toHaveProperty("ttlMs")
      expect(result).not.toHaveProperty("cacheScope")
    })

    it('events/list|subscribe|unsubscribe carry resultType "complete" and no ttlMs or cacheScope', async () => {
      const calls = [
        await call("events/list"),
        await call("events/subscribe", { name: "x", arguments: {}, delivery: {} }),
        await call("events/unsubscribe", { name: "x", arguments: {}, delivery: {} }),
      ]
      for (const r of calls) {
        expect(r.status).toBe(200)
        const result = json(r).result
        expect(result?.resultType).toBe("complete")
        expect(result).not.toHaveProperty("ttlMs")
        expect(result).not.toHaveProperty("cacheScope")
      }
    })

    it("events/unsubscribe returns `{}` plus resultType (not `{ ok: true }`)", async () => {
      const result = json(await call("events/unsubscribe", { name: "x", arguments: {}, delivery: {} })).result
      expect(result).not.toHaveProperty("ok")
      const { _meta, ...rest } = result ?? {}
      expect(rest).toEqual({ resultType: "complete" })
      expect(Object.keys(_meta ?? {})).toEqual(["io.modelcontextprotocol/serverInfo"])
    })

    it('a result\'s `resultType` is "complete" or "input_required", never absent', async () => {
      const probes: Array<[string, Json, Headers]> = [
        ["server/discover", {}, {}],
        ["tools/list", {}, {}],
        ["tools/call", { name: "probe", arguments: {} }, { "mcp-name": "probe" }],
        ["resources/list", {}, {}],
        ["resources/templates/list", {}, {}],
        ["resources/read", { uri: "file:///r.txt" }, { "mcp-name": "file:///r.txt" }],
        ["prompts/list", {}, {}],
        ["prompts/get", { name: "pr" }, { "mcp-name": "pr" }],
        ["events/list", {}, {}],
        ["events/subscribe", { name: "x", arguments: {}, delivery: {} }, {}],
        ["events/unsubscribe", { name: "x", arguments: {}, delivery: {} }, {}],
      ]
      for (const [method, params, headers] of probes) {
        const r = await call(method, params, { headers })
        expect(r.status, method).toBe(200)
        expect(["complete", "input_required"], method).toContain(json(r).result?.resultType)
      }
    })
  })

  describe("request validation", () => {
    it("missing MCP-Protocol-Version header (`-32020`, HTTP 400)", async () => {
      const r = await call("tools/list", {}, { headers: { "mcp-protocol-version": undefined } })
      expectError(r, 400, -32020)
      expect(r.status).toBe(ERROR_32020.httpStatus)
      expect(Object.keys(json(r).error ?? {}).sort()).toEqual(Object.keys(ERROR_32020.body.error).sort())
    })

    it("header differs from `_meta` version (`-32020`, HTTP 400)", async () => {
      expectError(await call("tools/list", {}, { headers: { "mcp-protocol-version": "2025-11-25" } }), 400, -32020)
    })

    it("`Mcp-Method` missing or different from `method` (`-32020`, HTTP 400)", async () => {
      expectError(await call("tools/list", {}, { headers: { "mcp-method": undefined } }), 400, -32020)
      expectError(await call("tools/list", {}, { headers: { "mcp-method": "tools/call" } }), 400, -32020)
    })

    it("`Mcp-Method` value is case-sensitive (`TOOLS/LIST` is `-32020`, HTTP 400)", async () => {
      expectError(await call("tools/list", {}, { headers: { "mcp-method": "TOOLS/LIST" } }), 400, -32020)
    })

    it("`Mcp-Name` missing or different on `tools/call` (`-32020`, HTTP 400)", async () => {
      expectError(await callTool({ "mcp-name": undefined }), 400, -32020)
      expectError(await callTool({ "mcp-name": "alpha" }), 400, -32020)
    })

    it("`Mcp-Name` missing or different on `resources/read` and `prompts/get` (`-32020`, HTTP 400)", async () => {
      const read = { uri: "file:///r.txt" }
      expectError(await call("resources/read", read, { headers: { "mcp-name": undefined } }), 400, -32020)
      expectError(await call("resources/read", read, { headers: { "mcp-name": "file:///other" } }), 400, -32020)
      expect((await call("resources/read", read, { headers: { "mcp-name": "file:///r.txt" } })).status).toBe(200)
      expectError(await call("prompts/get", { name: "pr" }, { headers: { "mcp-name": undefined } }), 400, -32020)
      expectError(await call("prompts/get", { name: "pr" }, { headers: { "mcp-name": "other" } }), 400, -32020)
      expect((await call("prompts/get", { name: "pr" }, { headers: { "mcp-name": "pr" } })).status).toBe(200)
    })

    it("`Mcp-Name` Base64 sentinel `=?base64?...?=` is decoded before comparison with params.name", async () => {
      const encoded = `=?base64?${Buffer.from("probe", "utf8").toString("base64")}?=`
      const r = await callTool({ "mcp-name": encoded })
      expect(r.status).toBe(200)
      expect(json(r).result?.content).toEqual([{ type: "text", text: "probe" }])
      const unicode = "café"
      const deps = serverWithTools(0, server => server.tool(unicode, "unicode tool", {}, async () => ({ content: [{ type: "text", text: "u" }] })))
      const u = await callTool({ "mcp-name": `=?base64?${Buffer.from(unicode, "utf8").toString("base64")}?=` }, unicode, { deps })
      expect(u.status).toBe(200)
    })

    it("`Mcp-Name` plain ASCII value that looks like the sentinel (`=?base64?...?=`) is compared as-is and mismatches (`-32020`)", async () => {
      // A tool whose real name looks like the sentinel must itself be sent encoded; sent raw it is decoded ("probe") and mismatches.
      const lookalike = "=?base64?cHJvYmU=?="
      expectError(await callTool({ "mcp-name": lookalike }, lookalike), 400, -32020)
      const encoded = `=?base64?${Buffer.from(lookalike, "utf8").toString("base64")}?=`
      const r = await callTool({ "mcp-name": encoded }, lookalike)
      expect(json(r).error?.code).not.toBe(-32020)
    })

    it("optional whitespace around `Mcp-Name` and `Mcp-Method` values is trimmed (RFC 9110 5.5)", async () => {
      expect((await callTool({ "mcp-name": "  probe  " })).status).toBe(200)
      expect((await call("tools/list", {}, { headers: { "mcp-method": "  tools/list\t" } })).status).toBe(200)
    })

    it("header names are case-insensitive", async () => {
      const r = await handleModernRequest(
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: ACCEPT, "MCP-Protocol-Version": VERSION, "MCP-METHOD": "tools/call", "MCP-NAME": "probe" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "probe", arguments: {}, _meta: META } }),
        },
        DEPS,
      )
      expect(r.status).toBe(200)
    })

    it("unsupported version (`-32022`, HTTP 400, `data.supported` and `data.requested`)", async () => {
      const requested = ERROR_32022.body.error.data.requested as string
      const r = await call("tools/list", {}, { meta: { ...META, [META_KEY]: requested }, headers: { "mcp-protocol-version": requested } })
      expectError(r, 400, -32022)
      expect(r.status).toBe(ERROR_32022.httpStatus)
      expect(json(r).error?.data).toEqual({ supported: [VERSION], requested })
    })

    it("`-32022` `data.supported` is a non-empty subset of discover `supportedVersions` (one shared constant)", async () => {
      const discover = json(await call("server/discover")).result?.supportedVersions as string[]
      const err = json(await call("tools/list", {}, { meta: { ...META, [META_KEY]: "1900-01-01" }, headers: { "mcp-protocol-version": "1900-01-01" } })).error
      expect(err?.data.supported.length).toBeGreaterThan(0)
      for (const version of err?.data.supported) expect(discover).toContain(version)
    })

    it("missing required `_meta` field (`-32602`, HTTP 400) for `protocolVersion` and for `clientCapabilities`", async () => {
      expectError(await call("tools/list", {}, { meta: { [CAPS_KEY]: {} } }), 400, -32602)
      expectError(await call("tools/list", {}, { meta: { [META_KEY]: VERSION } }), 400, -32602)
    })

    it("missing `_meta` entirely (`-32602`, HTTP 400)", async () => {
      expectError(await call("tools/list", {}, { meta: null }), 400, -32602)
    })

    it("`io.modelcontextprotocol/clientInfo` is optional (request without it is served, HTTP 200)", async () => {
      const r = await call("tools/list", {}, { meta: { [META_KEY]: VERSION, [CAPS_KEY]: {} } })
      expect(r.status).toBe(200)
    })

    it("unknown method (HTTP 404, `-32601`)", async () => {
      expectError(await call("nope/nothing"), 404, -32601)
    })

    it("removed legacy methods `initialize`, `ping`, `logging/setLevel`, `resources/subscribe`, `resources/unsubscribe` (HTTP 404, `-32601`)", async () => {
      const initialize = await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } }, { meta: null })
      expectError(initialize, 404, -32601)
      expect(json(initialize).error?.data).toEqual({ supported: [VERSION], requested: "2025-11-25" })
      for (const method of ["ping", "logging/setLevel", "resources/subscribe", "resources/unsubscribe"]) {
        expectError(await call(method), 404, -32601)
      }
    })

    it("a JSON-RPC error response carries the request `id`", async () => {
      for (const id of [7, "abc"]) {
        const r = await call("tools/list", {}, { id, headers: { "mcp-method": "tools/call" } })
        expectError(r, 400, -32020)
        expect(json(r).id).toBe(id)
      }
      expect(json(await call("nope/nothing", {}, { id: "n-1" })).id).toBe("n-1")
    })
  })

  describe("transport", () => {
    it("GET and DELETE (405)", async () => {
      for (const verb of ["GET", "DELETE"]) {
        const r = await call("tools/list", {}, { verb })
        expect(r.status, verb).toBe(405)
        expect(r.headers["allow"]).toBe("POST")
      }
    })

    it("`Mcp-Session-Id` and `Last-Event-ID` ignored; no `Mcp-Session-Id` response header", async () => {
      const r = await call("tools/list", {}, { headers: { "mcp-session-id": "abc", "last-event-id": "5" } })
      expect(r.status).toBe(200)
      expect(json(r).result?.tools).toHaveLength(2)
      expect(Object.keys(r.headers).map(k => k.toLowerCase())).not.toContain("mcp-session-id")
    })

    it("notification without `id` that the server accepts (202 Accepted, no body)", async () => {
      const r = await call("notifications/initialized", {}, { body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })
      expect(r.status).toBe(202)
      expect(r.body).toBeUndefined()
    })

    it("response `Content-Type` is `application/json` or `text/event-stream`", async () => {
      const replies = [
        await call("tools/list"),
        await call("nope/nothing"),
        await call("tools/list", {}, { headers: { "mcp-method": "x" } }),
        await call("tools/list", {}, { verb: "GET" }),
        await call("tools/list", {}, { body: "{nope" }),
      ]
      for (const r of replies) expect(["application/json", "text/event-stream"]).toContain(r.headers["content-type"])
    })

    it("the POST body is a single JSON-RPC request or notification, never a response", async () => {
      for (const body of [
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "x" } }),
        JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
      ]) {
        const r = await call("tools/list", {}, { body })
        expectError(r, 400, -32600)
        expect(json(r).id).toBeNull()
      }
    })
  })

  describe("caching hints", () => {
    const policies: Array<[string, ModernDeps]> = [
      ["default policy", DEPS],
      ["custom policy", { ...DEPS, cachePolicy: () => ({ ttlMs: 300000, cacheScope: "public" }) }],
    ]

    async function cacheable(deps: ModernDeps): Promise<Array<[string, Json | undefined]>> {
      const out: Array<[string, Json | undefined]> = []
      for (const method of SIX_CACHEABLE) {
        const params = method === "resources/read" ? { uri: "file:///r.txt" } : {}
        const headers = method === "resources/read" ? { "mcp-name": "file:///r.txt" } : {}
        const r = await call(method, params, { deps, headers })
        expect(r.status, method).toBe(200)
        out.push([method, json(r).result])
      }
      return out
    }

    it("ttlMs and cacheScope are present on server/discover, tools/list, prompts/list, resources/list, resources/templates/list and resources/read", async () => {
      for (const [, deps] of policies) {
        for (const [method, result] of await cacheable(deps)) {
          expect(result, method).toHaveProperty("ttlMs")
          expect(result, method).toHaveProperty("cacheScope")
        }
      }
    })

    it("ttlMs and cacheScope are absent on tools/call, prompts/get and events/*", async () => {
      const replies = [
        await callTool(),
        await call("prompts/get", { name: "pr" }, { headers: { "mcp-name": "pr" } }),
        await call("events/list"),
        await call("events/subscribe", { name: "x", arguments: {}, delivery: {} }),
        await call("events/unsubscribe", { name: "x", arguments: {}, delivery: {} }),
      ]
      for (const r of replies) {
        expect(r.status).toBe(200)
        expect(json(r).result).not.toHaveProperty("ttlMs")
        expect(json(r).result).not.toHaveProperty("cacheScope")
      }
    })

    it("`ttlMs` is an integer >= 0", async () => {
      for (const [, deps] of policies) {
        for (const [method, result] of await cacheable(deps)) {
          expect(Number.isInteger(result?.ttlMs), method).toBe(true)
          expect(result?.ttlMs, method).toBeGreaterThanOrEqual(0)
        }
      }
    })

    it('`cacheScope` accepts only "public" or "private"', async () => {
      for (const [, deps] of policies) {
        for (const [method, result] of await cacheable(deps)) expect(["public", "private"], method).toContain(result?.cacheScope)
      }
    })

    it("all pages of one paginated list share the same `cacheScope`", async () => {
      const pages = [["t0"], ["t1"], ["t2"]]
      const deps: ModernDeps = {
        ...serverWithTools(3, server => {
          server.server.setRequestHandler(ListToolsRequestSchema, async req => {
            const index = req.params?.cursor === undefined ? 0 : Number(req.params.cursor)
            const next = index + 1 < pages.length ? String(index + 1) : undefined
            return { tools: pages[index]!.map(name => ({ name, inputSchema: { type: "object" as const } })), ...(next ? { nextCursor: next } : {}) }
          })
        }),
        cachePolicy: () => ({ ttlMs: 60000, cacheScope: "private" }),
      }
      const seen: string[] = []
      let cursor: string | undefined
      let count = 0
      do {
        const result = json(await call("tools/list", cursor === undefined ? {} : { cursor }, { deps })).result
        seen.push(result?.cacheScope)
        cursor = result?.nextCursor
        count++
      } while (cursor !== undefined && count < 10)
      expect(count).toBe(3)
      expect(new Set(seen).size).toBe(1)
    })

    it("an `input_required` result carries no caching hints", async () => {
      const deps = serverWithTools(1, server => {
        server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [], resultType: "input_required" }) as never)
      })
      const result = json(await call("tools/list", {}, { deps })).result
      expect(result?.resultType).toBe("input_required")
      expect(result).not.toHaveProperty("ttlMs")
      expect(result).not.toHaveProperty("cacheScope")
    })
  })
})

describe("local policy (live)", () => {
  describe("verbs", () => {
    for (const verb of ["OPTIONS", "HEAD", "GET", "DELETE"]) {
      const label = verb === "OPTIONS" ? "OPTIONS is 405 with `Allow: POST` (the CORS layer's 204 must not answer it)" : `${verb} is 405 with \`Allow: POST\`${verb === "GET" ? " (no idle SSE stream)" : ""}`
      it(label, async () => {
        const r = await call("tools/list", {}, { verb })
        expect(r.status).toBe(405)
        expect(r.headers["allow"]).toBe("POST")
      })
    }
  })

  describe("content negotiation and body", () => {
    it("missing or wrong `Accept` is 406", async () => {
      expectError(await call("tools/list", {}, { headers: { accept: undefined } }), 406, -32600)
      expectError(await call("tools/list", {}, { headers: { accept: "text/event-stream" } }), 406, -32600)
    })

    it("`Content-Type` other than application/json is 415", async () => {
      expectError(await call("tools/list", {}, { headers: { "content-type": "text/plain" } }), 415, -32600)
      expectError(await call("tools/list", {}, { headers: { "content-type": undefined } }), 415, -32600)
    })

    it("malformed JSON is 400 with `-32700` and `id: null`", async () => {
      const r = await call("tools/list", {}, { body: "{not json" })
      expectError(r, 400, -32700)
      expect(json(r).id).toBeNull()
    })

    it("a JSON-RPC response body or a batch body is 400 with `-32600`", async () => {
      for (const body of [JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }])]) {
        const r = await call("tools/list", {}, { body })
        expectError(r, 400, -32600)
        expect(json(r).id).toBeNull()
      }
    })
  })

  describe("headers and metadata", () => {
    it("request `_meta` is not echoed into results", async () => {
      const meta = { ...META, progressToken: "p-1", traceparent: "00-abc-def-01", "vendor/secret": "do-not-echo" }
      for (const r of [await call("tools/list", {}, { meta }), await call("events/list", {}, { meta }), await call("server/discover", {}, { meta })]) {
        expect(r.status).toBe(200)
        expect(Object.keys(json(r).result?._meta ?? {})).toEqual(["io.modelcontextprotocol/serverInfo"])
        expect(r.body).not.toContain("do-not-echo")
      }
    })

    it("header requirements on a notification POST are not enforced (the spec leaves them undefined)", async () => {
      const r = await handleModernRequest(
        { method: "POST", headers: { "content-type": "application/json", accept: ACCEPT }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) },
        DEPS,
      )
      expect(r.status).toBe(202)
    })

    it("duplicate MCP-Protocol-Version, Mcp-Method or Mcp-Name values (spec silent; policy for P1 to choose)", async () => {
      // Policy chosen: reject. A duplicated header is joined with ", ", which can never equal the one expected value.
      expectError(await call("tools/list", {}, { headers: { "mcp-protocol-version": [VERSION, VERSION] } }), 400, -32020)
      expectError(await call("tools/list", {}, { headers: { "mcp-method": ["tools/list", "tools/list"] } }), 400, -32020)
      expectError(await callTool({ "mcp-name": ["probe", "probe"] }), 400, -32020)
    })
  })
})
