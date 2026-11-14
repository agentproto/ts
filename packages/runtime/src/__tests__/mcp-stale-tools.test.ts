/**
 * Stale `tools/list` cache.
 *
 * Symptom: an imported MCP served over stateless streamable HTTP
 * (`sessionIdGenerator: undefined`, no `Mcp-Session-Id`) was restarted with
 * more tools, and the daemon kept reporting/forwarding the old list forever.
 * A stateless restart never looks like a disconnect, so a cache that is only
 * dropped on connection death never expires.
 *
 * These tests drive a REAL in-process stateless HTTP MCP server whose tool
 * list changes underneath a live client, one test per refresh rule:
 *   1. `notifications/tools/list_changed` drops the cached list,
 *   2. an HTTP cache older than the TTL is re-listed at read time
 *      (`listTools` = tool_list/passthrough, `listAliases` = status),
 *   3. a `tools/call` for a name missing from the cache re-lists first, and
 *      an upstream "unknown tool" error drops the cache,
 *   4. `invalidate` (what `mcp_import` of an existing id calls) drops the
 *      pooled client + cache.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"

const actualRef = vi.hoisted(() => ({
  open: undefined as undefined | ((...args: never[]) => Promise<Client>),
}))
const openMock = vi.hoisted(() => vi.fn())

vi.mock("../mcp-client-pool.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../mcp-client-pool.js")>()
  actualRef.open = actual.openMcpClient as never
  return { ...actual, openMcpClient: openMock }
})

import {
  McpClientPool,
  type McpConnectionConfig,
} from "../mcp-client-pool.js"
import { McpProxyRegistry } from "../mcp-proxy.js"
import {
  IMPORTED_MCPS_PATH,
  saveImportedMcps,
  type ImportedMcpEntry,
} from "../mcp-imports.js"

let httpServer: Server
let baseUrl: string
/** The live tool set the fake server serves, mutated per test. */
let toolNames: string[] = []
/** How many `tools/list` requests the real server has served. */
let listRequests = 0

function buildServer(): McpServer {
  const server = new McpServer({ name: "stale-fixture", version: "1.0.0" })
  for (const name of toolNames) {
    server.registerTool(name, { description: name }, async () => ({
      content: [{ type: "text", text: `ok:${name}` }],
    }))
  }
  server.server.setRequestHandler(ListToolsRequestSchema, () => {
    listRequests += 1
    return {
      tools: toolNames.map(name => ({
        name,
        description: name,
        inputSchema: { type: "object" },
      })),
    }
  })
  return server
}

beforeAll(async () => {
  httpServer = createServer(async (req, res) => {
    const server = buildServer()
    // Stateless: no session id, so a server restart is invisible to a client
    // holding an open connection. This is the exact shape of the bug.
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
  httpServer.closeAllConnections?.()
  await new Promise<void>(resolve => httpServer.close(() => resolve()))
})

let home: string
let prevHome: string | undefined
const TTL = 45_000
let clock = 1_000_000

function entry(): ImportedMcpEntry {
  return {
    id: "fixture:stale",
    alias: "stale",
    addedAt: "2026-01-01T00:00:00.000Z",
    snapshot: {
      id: "fixture:stale",
      source: "workspace",
      scope: "workspace",
      name: "stale",
      type: "http",
      url: `${baseUrl}/mcp`,
    },
  }
}

const pools: McpClientPool[] = []

beforeEach(async () => {
  toolNames = []
  listRequests = 0
  clock = 1_000_000
  home = mkdtempSync(join(tmpdir(), "mcp-stale-"))
  mkdirSync(join(home, ".agentproto"), { recursive: true })
  prevHome = process.env.HOME
  process.env.HOME = home
  openMock.mockReset()
  // Real network by default; the notification test overrides this once.
  openMock.mockImplementation((...args: never[]) => actualRef.open!(...args))
  await saveImportedMcps({ version: 1, imports: [entry()] }, IMPORTED_MCPS_PATH())
})

afterEach(async () => {
  await Promise.all(pools.splice(0).map(p => p.closeAll()))
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  rmSync(home, { recursive: true, force: true })
})

function registry(): McpProxyRegistry {
  return new McpProxyRegistry({ toolCacheTtlMs: TTL, now: () => clock })
}

function pool(): McpClientPool {
  const p = new McpClientPool(
    (config, label) => actualRef.open!(config as never, { label } as never),
    { toolCacheTtlMs: TTL, now: () => clock }
  )
  pools.push(p)
  return p
}

function config(): McpConnectionConfig {
  return { type: "http", url: `${baseUrl}/mcp` }
}

function namesOf(tools: readonly { name: string }[]): string[] {
  return tools.map(t => t.name)
}

/** A fake MCP client that records the handlers the pool installs, so the
 *  server-initiated notification can be delivered directly. A stateless
 *  streamable-HTTP server has no open stream to push one over, so rule 1 is
 *  exercised at the handler boundary the pool registers. */
function fakeClient(getTools: () => Tool[]): {
  client: Client
  fireToolsChanged: () => Promise<void>
} {
  let onToolListChanged: (() => void | Promise<void>) | undefined
  const client = {
    listTools: async () => ({ tools: getTools() }),
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    readResource: async () => ({ contents: [] }),
    close: async () => {},
    setNotificationHandler: (schema: unknown, handler: () => void | Promise<void>) => {
      if (schema === ToolListChangedNotificationSchema) onToolListChanged = handler
    },
  } as unknown as Client
  return {
    client,
    fireToolsChanged: async () => {
      if (!onToolListChanged) throw new Error("no tools/list_changed handler registered")
      await onToolListChanged()
    },
  }
}

describe("McpProxyRegistry: stale tools cache", () => {
  it("rule 1: drops the cache on notifications/tools/list_changed", async () => {
    let tools: Tool[] = [{ name: "ping" } as Tool]
    const fake = fakeClient(() => tools)
    openMock.mockResolvedValue(fake.client)
    const reg = registry()

    const first = await reg.listTools("stale")
    expect(first.ok && namesOf(first.tools)).toEqual(["ping"])

    tools = [{ name: "ping" } as Tool, { name: "fresh_tool" } as Tool]
    await fake.fireToolsChanged()

    const after = await reg.listTools("stale")
    expect(after.ok && namesOf(after.tools)).toContain("fresh_tool")
  })

  it("rule 2: re-lists an HTTP cache older than the TTL for tool_list and status", async () => {
    toolNames = ["ping"]
    const reg = registry()
    expect((await reg.listTools("stale")).ok).toBe(true)

    toolNames = ["ping", "fresh_tool"]

    clock += TTL - 1
    const withinTtl = await reg.listTools("stale")
    expect(withinTtl.ok && namesOf(withinTtl.tools)).toEqual(["ping"])
    const statusWithinTtl = await reg.listAliases()
    expect(statusWithinTtl[0]?.toolCount).toBe(1)

    clock += 2
    const afterTtl = await reg.listTools("stale")
    expect(afterTtl.ok && namesOf(afterTtl.tools)).toContain("fresh_tool")
    const statusAfterTtl = await reg.listAliases()
    expect(statusAfterTtl[0]?.toolCount).toBe(2)
  })

  it("rule 3a: re-lists before a tools/call for a name missing from the cache", async () => {
    toolNames = ["ping"]
    const reg = registry()
    expect((await reg.listTools("stale")).ok).toBe(true)

    toolNames = ["ping", "fresh_tool"]
    const out = await reg.callTool("stale", "fresh_tool", {})
    expect(out.ok).toBe(true)

    const after = await reg.listTools("stale")
    expect(after.ok && namesOf(after.tools)).toContain("fresh_tool")
  })

  it("rule 3b: drops the cache when the upstream reports an unknown tool", async () => {
    toolNames = ["ping", "removed_tool"]
    const reg = registry()
    expect((await reg.listTools("stale")).ok).toBe(true)

    toolNames = ["ping"]
    const call = await reg.callTool("stale", "removed_tool", {})
    expect(call.ok).toBe(true)
    if (call.ok) {
      // The SDK reports an unknown tool as an `isError` result, not a throw.
      expect((call.result as { isError?: boolean }).isError).toBe(true)
    }

    const after = await reg.listTools("stale")
    expect(after.ok && namesOf(after.tools)).toEqual(["ping"])
  })

  it("rule 4: invalidate drops the pooled client and cache", async () => {
    toolNames = ["ping"]
    const reg = registry()
    expect((await reg.listTools("stale")).ok).toBe(true)
    expect(listRequests).toBe(1)

    toolNames = ["ping", "fresh_tool"]
    await reg.invalidate("fixture:stale")

    const after = await reg.listTools("stale")
    expect(after.ok && namesOf(after.tools)).toContain("fresh_tool")
    expect(listRequests).toBe(2)
  })
})

describe("PooledMcpClient: stale tools cache", () => {
  it("rule 1: drops the cache on notifications/tools/list_changed", async () => {
    let tools: Tool[] = [{ name: "ping" } as Tool]
    const fake = fakeClient(() => tools)
    const p = new McpClientPool(() => Promise.resolve(fake.client), {
      toolCacheTtlMs: TTL,
      now: () => clock,
    })
    pools.push(p)
    const client = p.get(config(), "fixture")

    expect(namesOf(await client.listTools())).toEqual(["ping"])
    tools = [{ name: "ping" } as Tool, { name: "fresh_tool" } as Tool]
    await fake.fireToolsChanged()
    expect(namesOf(await client.listTools())).toContain("fresh_tool")
  })

  it("rule 2: re-lists an HTTP cache older than the TTL", async () => {
    toolNames = ["ping"]
    const client = pool().get(config(), "fixture")
    expect(namesOf(await client.listTools())).toEqual(["ping"])

    toolNames = ["ping", "fresh_tool"]
    clock += TTL - 1
    expect(namesOf(await client.listTools())).toEqual(["ping"])

    clock += 2
    expect(namesOf(await client.listTools())).toContain("fresh_tool")
  })

  it("rule 3: re-lists before a tools/call for a name missing from the cache", async () => {
    toolNames = ["ping"]
    const client = pool().get(config(), "fixture")
    expect(namesOf(await client.listTools())).toEqual(["ping"])

    toolNames = ["ping", "fresh_tool"]
    const result = await client.callTool("fresh_tool", {})
    expect(result.content).toEqual([{ type: "text", text: "ok:fresh_tool" }])
    expect(namesOf(await client.listTools())).toContain("fresh_tool")
  })

  it("coalesces concurrent refreshes into one tools/list", async () => {
    toolNames = ["ping"]
    const client = pool().get(config(), "fixture")
    expect(namesOf(await client.listTools())).toEqual(["ping"])
    expect(listRequests).toBe(1)

    toolNames = ["ping", "fresh_tool"]
    clock += TTL + 1
    await Promise.all([client.listTools(), client.listTools(), client.listTools()])
    expect(listRequests).toBe(2)
  })
})
