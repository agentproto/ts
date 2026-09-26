/**
 * McpAppsHostService against a REAL in-process MCP server (streamable HTTP
 * on 127.0.0.1) whose UI tools come from `registerMcpApps` with real
 * `@agentproto/apps` panels, plus one app-only tool. Covers the UI index,
 * `ui_read` refusal, the `tool_call` allowlist + event record, the negative
 * cache, status mapping and config-keyed pooling.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { makeSessionsPanelApp, makeWorkBoardApp } from "@agentproto/apps"
import { registerUiResource } from "@agentproto/mcp-server"
import { registerMcpApps } from "../mcp-apps-adapter.js"
import { McpClientPool, openMcpClient, MCP_APPS_CLIENT_CAPABILITIES, type McpConnectionConfig } from "../mcp-client-pool.js"
import {
  McpAppsHostService,
  classifyMcpError,
  type McpAppToolCallRecord,
  type McpAppUi,
  type McpAppUiReadError,
} from "../mcp-apps-host.js"
import type { ResolvedMcpServer } from "../mcp-app-resolve.js"

let httpServer: Server
let baseUrl: string
/** Extra tool registered on the next connect — proves a reconnect re-lists. */
let extraUiTool = false
const upstreamCalls: string[] = []

function buildFixtureServer(): McpServer {
  const server = new McpServer({ name: "fixture", version: "1.0.0" })
  registerMcpApps(server, [
    makeSessionsPanelApp({ listSessions: () => [] }),
    makeWorkBoardApp({ listTasks: () => ({ tasks: [] }) as never }),
  ])
  // App-only tool: callable by the iframe, hidden from the model, no UI.
  server.registerTool(
    "board_refresh",
    { description: "refresh", _meta: { ui: { visibility: ["app"] } } },
    async () => {
      upstreamCalls.push("board_refresh")
      return { content: [{ type: "text", text: "refreshed" }] }
    }
  )
  server.registerTool("plain_tool", { description: "model-only, no UI" }, async () => {
    upstreamCalls.push("plain_tool")
    return { content: [{ type: "text", text: "plain" }] }
  })
  server.registerTool("admin_delete_all", { description: "must never be reachable from an app" }, async () => {
    upstreamCalls.push("admin_delete_all")
    return { content: [{ type: "text", text: "deleted" }] }
  })
  // A ui:// resource that exists on the server but no tool declares.
  registerUiResource(server, { name: "hidden", uri: "ui://hidden/view", html: "<html>secret</html>" })
  if (extraUiTool) {
    registerUiResource(server, { name: "late", uri: "ui://late/view", html: "<html>late</html>" })
    server.registerTool(
      "late_panel",
      { description: "late", _meta: { ui: { resourceUri: "ui://late/view" } } },
      async () => ({ content: [{ type: "text", text: "{}" }] })
    )
  }
  return server
}

beforeAll(async () => {
  httpServer = createServer(async (req, res) => {
    if (req.url?.startsWith("/unauth")) {
      res.writeHead(401, { "www-authenticate": 'Bearer realm="fixture"' })
      res.end("unauthorized")
      return
    }
    const server = buildFixtureServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on("close", () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  })
  await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => httpServer.close(() => resolve()))
})

const pools: McpClientPool[] = []
afterEach(async () => {
  extraUiTool = false
  upstreamCalls.length = 0
  await Promise.all(pools.splice(0).map(p => p.closeAll()))
})

function fixtureConfig(path = "/mcp"): McpConnectionConfig {
  return { type: "http", url: `${baseUrl}${path}` }
}

function makeHost(opts: {
  resolve?: (sessionId: string, alias: string) => Promise<ResolvedMcpServer | null | undefined>
  lookupToolCallName?: (sessionId: string, toolCallId: string) => Promise<string | undefined>
  now?: () => number
  countConnects?: { n: number }
} = {}) {
  const records: Array<{ sessionId: string } & McpAppToolCallRecord> = []
  const pool = new McpClientPool(async (config, label) => {
    if (opts.countConnects) opts.countConnects.n += 1
    return openMcpClient(config, { label, capabilities: MCP_APPS_CLIENT_CAPABILITIES })
  })
  pools.push(pool)
  const resolveCalls: string[] = []
  const host = new McpAppsHostService({
    pool,
    resolve: async (sessionId, alias) => {
      resolveCalls.push(`${sessionId}/${alias}`)
      if (opts.resolve) return opts.resolve(sessionId, alias)
      return { alias, source: "session", origin: `session:${sessionId}`, config: fixtureConfig() }
    },
    recordToolCall: (sessionId, record) => records.push({ sessionId, ...record }),
    ...(opts.lookupToolCallName ? { lookupToolCallName: opts.lookupToolCallName } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  })
  return { host, pool, records, resolveCalls }
}

function text(result: CallToolResult): string {
  const first = result.content[0]
  return first && first.type === "text" ? first.text : ""
}

describe("McpAppsHostService.uiIndex", () => {
  it("lists registerMcpApps UI tools + app-only tools from a live server", async () => {
    const { host } = makeHost()
    const index = await host.uiIndex("s1", "fixture")
    expect(index.status).toBe("ok")
    expect(index.source).toBe("session")
    expect(index.error).toBeUndefined()
    expect(index.tools.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "agentproto_sessions", resourceUri: "ui://agentproto_sessions/view", appOnly: false },
      { name: "agentproto_work_board", resourceUri: "ui://agentproto_work_board/view", appOnly: false },
    ])
    expect(index.appOnlyTools).toEqual(["board_refresh"])
  })

  it("shares one pooled client across sessions that resolve to the same config", async () => {
    const connects = { n: 0 }
    const { host, pool } = makeHost({ countConnects: connects })
    await host.uiIndex("s1", "fixture")
    await host.uiIndex("s2", "fixture")
    expect(pool.size).toBe(1)
    expect(connects.n).toBe(1)
  })

  it("rebuilds the index after a reconnect", async () => {
    const { host, pool } = makeHost()
    const before = await host.uiIndex("s1", "fixture")
    expect(before.tools.map(t => t.name)).not.toContain("late_panel")
    extraUiTool = true
    await pool.get(fixtureConfig(), "x").reset()
    const after = await host.uiIndex("s1", "fixture")
    expect(after.tools.map(t => t.name)).toContain("late_panel")
  })
})

describe("McpAppsHostService status mapping", () => {
  it("unresolved: no config for the alias, and unknown session", async () => {
    const { host } = makeHost({
      resolve: async sessionId => (sessionId === "gone" ? undefined : null),
    })
    const none = await host.uiIndex("s1", "nope")
    expect(none).toMatchObject({ server: "nope", status: "unresolved", tools: [], appOnlyTools: [] })
    expect(none.error).toMatch(/no MCP server named "nope"/)
    const gone = await host.uiIndex("gone", "fixture")
    expect(gone.status).toBe("unresolved")
    expect(gone.error).toMatch(/unknown session/)
  })

  it("auth_required: the server answers 401", async () => {
    const { host } = makeHost({
      resolve: async alias => ({ alias, source: "user", origin: "x", config: fixtureConfig("/unauth") }),
    })
    const index = await host.uiIndex("s1", "locked")
    expect(index).toMatchObject({ status: "auth_required", source: "user", tools: [] })
  })

  it("unreachable: nothing listens, or the config can't open a transport", async () => {
    const closed = createServer()
    await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>(resolve => closed.close(() => resolve()))
    const { host } = makeHost({
      resolve: async (_s, alias) =>
        alias === "dead"
          ? { alias, source: "imported", origin: "x", config: { type: "http", url: `http://127.0.0.1:${port}/mcp` } }
          : { alias, source: "project", origin: "x", config: { type: "unknown" } },
    })
    expect((await host.uiIndex("s1", "dead")).status).toBe("unreachable")
    const bad = await host.uiIndex("s1", "weird")
    expect(bad.status).toBe("unreachable")
    expect(bad.error).toMatch(/unsupported transport type "unknown"/)
  })

  it("classifyMcpError maps 401-shaped errors to auth_required", () => {
    expect(classifyMcpError(new Error("Streamable HTTP error: Error POSTing to endpoint: 401")).status).toBe("auth_required")
    expect(classifyMcpError(new Error("fetch failed")).status).toBe("unreachable")
  })
})

describe("McpAppsHostService negative cache", () => {
  it("remembers a failure per (session, alias) for 60s, then retries", async () => {
    let t = 1_000_000
    const { host, resolveCalls } = makeHost({ now: () => t, resolve: async () => null })
    await host.uiIndex("s1", "nope")
    await host.uiIndex("s1", "nope")
    await host.uiIndex("s1", "nope")
    expect(resolveCalls).toEqual(["s1/nope"])
    // A different session is its own cache key.
    await host.uiIndex("s2", "nope")
    expect(resolveCalls).toEqual(["s1/nope", "s2/nope"])
    t += 59_999
    await host.uiIndex("s1", "nope")
    expect(resolveCalls).toHaveLength(2)
    t += 2
    await host.uiIndex("s1", "nope")
    expect(resolveCalls).toEqual(["s1/nope", "s2/nope", "s1/nope"])
  })

  it("does not re-dial a 401 server within the TTL", async () => {
    const connects = { n: 0 }
    const { host } = makeHost({
      countConnects: connects,
      resolve: async alias => ({ alias, source: "user", origin: "x", config: fixtureConfig("/unauth") }),
    })
    await host.uiIndex("s1", "locked")
    await host.uiIndex("s1", "locked")
    await host.readUi("s1", "locked", "ui://x/view")
    expect(connects.n).toBe(1)
  })
})

describe("McpAppsHostService.readUi", () => {
  it("returns html + _meta.ui for a uri the index declares", async () => {
    const { host } = makeHost()
    const ui = (await host.readUi("s1", "fixture", "ui://agentproto_sessions/view")) as McpAppUi
    expect(ui.resourceUri).toBe("ui://agentproto_sessions/view")
    expect(ui.mimeType).toBe("text/html;profile=mcp-app")
    expect(ui.html).toMatch(/<html|<!doctype/i)
    expect(ui.prefersBorder).toBe(true)
  })

  it("refuses a uri no tool of that server declares — even one the server serves", async () => {
    const { host } = makeHost()
    const hidden = (await host.readUi("s1", "fixture", "ui://hidden/view")) as McpAppUiReadError
    expect(hidden.status).toBe("ok")
    expect(hidden.error).toMatch(/not declared by any tool/)
    expect("html" in hidden).toBe(false)
  })

  it("passes a non-ok index status through as { error, status }", async () => {
    const { host } = makeHost({ resolve: async () => null })
    const r = (await host.readUi("s1", "nope", "ui://agentproto_sessions/view")) as McpAppUiReadError
    expect(r.status).toBe("unresolved")
  })
})

describe("McpAppsHostService.callTool", () => {
  it("forwards an app-only tool and a UI tool, recording each call", async () => {
    const { host, records } = makeHost()
    const r1 = await host.callTool({ sessionId: "s1", server: "fixture", tool: "board_refresh", originToolCallId: "tc-1" })
    expect(r1.isError).toBeFalsy()
    expect(text(r1)).toBe("refreshed")
    const r2 = await host.callTool({
      sessionId: "s1",
      server: "fixture",
      tool: "agentproto_sessions",
      args: { filter: "all" },
      originToolCallId: "tc-1",
    })
    expect(r2.isError).toBeFalsy()
    expect(records.map(({ durationMs, ...r }) => r)).toEqual([
      { sessionId: "s1", server: "fixture", tool: "board_refresh", originToolCallId: "tc-1", isError: false },
      { sessionId: "s1", server: "fixture", tool: "agentproto_sessions", originToolCallId: "tc-1", isError: false },
    ])
    expect(records.every(r => typeof r.durationMs === "number")).toBe(true)
  })

  it("refuses a tool outside the allowlist without calling upstream or recording", async () => {
    const { host, records } = makeHost()
    const r = await host.callTool({ sessionId: "s1", server: "fixture", tool: "admin_delete_all", originToolCallId: "tc-1" })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/not callable from an app UI/)
    expect(upstreamCalls).toEqual([])
    expect(records).toEqual([])
  })

  it("allows the tool whose transcript card hosts the iframe", async () => {
    const { host } = makeHost({
      lookupToolCallName: async (_s, id) => (id === "tc-plain" ? "mcp__fixture__plain_tool" : undefined),
    })
    const ok = await host.callTool({ sessionId: "s1", server: "fixture", tool: "plain_tool", originToolCallId: "tc-plain" })
    expect(text(ok)).toBe("plain")
    const other = await host.callTool({ sessionId: "s1", server: "fixture", tool: "plain_tool", originToolCallId: "tc-other" })
    expect(other.isError).toBe(true)
    expect(upstreamCalls).toEqual(["plain_tool"])
  })

  it("returns an isError result when the server is not ok", async () => {
    const { host } = makeHost({ resolve: async () => null })
    const r = await host.callTool({ sessionId: "s1", server: "nope", tool: "x", originToolCallId: "tc" })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/unresolved/)
  })
})
