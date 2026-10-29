/**
 * T15 on the imported-call gate: the guard derives the CALLER's node scope
 * itself and forwards the caller's session id and node to an imported http/sse
 * server as per-call headers (`x-agentproto-caller-session`,
 * `x-agentproto-caller-node`). A missing or unknown caller identity is refused
 * and the upstream is never contacted; a host call forwards nothing. Shared
 * fixture; a real loopback MCP server proves the headers reach the wire.
 */

import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"

import { CALLER_NODE_HEADER, CALLER_SESSION_HEADER } from "../caller-scope.js"
import { createImportedCallGuard } from "../imported-call-gate.js"
import {
  callerForwardingFetch,
  currentCallHeaders,
  openMcpClient,
  shouldForwardCallerHeaders,
  withCallHeaders,
} from "../mcp-client-pool.js"
import { McpProxyRegistry } from "../mcp-proxy.js"
import { PERSO_ID, NOTES_ID, SESSION, buildCallerFixture, type CallerFixture } from "./caller-scope-fixture.js"

let fx: CallerFixture
beforeEach(() => {
  fx = buildCallerFixture()
})
afterEach(() => fx.cleanup())

function proxyWith(upstream: (headers: Record<string, string> | undefined) => unknown) {
  const proxy = new McpProxyRegistry()
  const registry = {
    get: (id: string) => fx.sessions.get(id),
    requestToolPermission: vi.fn(),
  }
  proxy.setCallGuard(createImportedCallGuard({ registry: registry as never, workspace: fx.free, scopes: fx.scopes } as never))
  const seen: Array<Record<string, string> | undefined> = []
  const callTool = vi.fn(async () => {
    const headers = currentCallHeaders?.()
    seen.push(headers)
    return upstream(headers)
  })
  vi.spyOn(proxy as never, "connectIfNeeded" as never).mockImplementation((async () => ({
    alias: "app",
    client: { callTool },
    tools: [],
  })) as never)
  return { proxy, callTool, seen }
}

describe("the guard derives the caller and forwards it", () => {
  it("a sealed session forwards its id and its sealed node", async () => {
    const { proxy, seen } = proxyWith(() => ({ content: [] }))
    const out = await proxy.callTool("app", "whoami", {}, { callerSessionId: SESSION.perso })
    expect(out.ok).toBe(true)
    expect(seen).toEqual([{ [CALLER_SESSION_HEADER]: SESSION.perso, [CALLER_NODE_HEADER]: PERSO_ID }])
  })

  it("a sibling forwards its own node, never the sealed one", async () => {
    const { proxy, seen } = proxyWith(() => ({ content: [] }))
    await proxy.callTool("app", "whoami", {}, { callerSessionId: SESSION.notes })
    expect(seen).toEqual([{ [CALLER_SESSION_HEADER]: SESSION.notes, [CALLER_NODE_HEADER]: NOTES_ID }])
    expect(JSON.stringify(seen)).not.toContain(PERSO_ID)
  })

  it("a session in no declared tree forwards its id and no node", async () => {
    const { proxy, seen } = proxyWith(() => ({ content: [] }))
    await proxy.callTool("app", "whoami", {}, { callerSessionId: SESSION.free })
    expect(seen).toEqual([{ [CALLER_SESSION_HEADER]: SESSION.free }])
  })

  it("a host call (no caller session) forwards nothing and is still served", async () => {
    const { proxy, seen, callTool } = proxyWith(() => ({ content: [] }))
    const out = await proxy.callTool("app", "whoami", {})
    expect(out.ok).toBe(true)
    expect(callTool).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([undefined])
  })

  it("headers do not leak from one call to the next", async () => {
    const { proxy, seen } = proxyWith(() => ({ content: [] }))
    await proxy.callTool("app", "whoami", {}, { callerSessionId: SESSION.perso })
    await proxy.callTool("app", "whoami", {})
    expect(seen[1]).toBeUndefined()
    expect(currentCallHeaders()).toBeUndefined()
  })
})

describe("a missing or unknown caller identity is refused", () => {
  it("an unknown caller id never reaches the upstream", async () => {
    const { proxy, callTool } = proxyWith(() => ({ content: [] }))
    const out = await proxy.callTool("app", "whoami", {}, { callerSessionId: SESSION.ghost })
    expect(out.ok).toBe(false)
    expect((out as { error: string }).error).toMatch(/refused/i)
    expect(callTool).not.toHaveBeenCalled()
  })

  it("a refusal is the same for every tool, hooks or not", async () => {
    const { proxy, callTool } = proxyWith(() => ({ content: [] }))
    for (const tool of ["send_message", "whoami", "anything"]) {
      const out = await proxy.callTool("app", tool, {}, { callerSessionId: SESSION.ghost })
      expect(out.ok, tool).toBe(false)
    }
    expect(callTool).not.toHaveBeenCalled()
  })
})

describe("the per-call header carrier", () => {
  it("adds the caller headers inside withCallHeaders and nothing outside", async () => {
    const seen: Array<Headers> = []
    const base = (async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
      return new Response("{}")
    }) as typeof fetch
    const wrapped = callerForwardingFetch(base)
    await wrapped("http://127.0.0.1:1/mcp", { headers: { authorization: "Bearer x" } })
    await withCallHeaders({ [CALLER_SESSION_HEADER]: "s1", [CALLER_NODE_HEADER]: "@me/notes" }, () =>
      wrapped("http://127.0.0.1:1/mcp", { headers: { authorization: "Bearer x" } }),
    )
    expect(seen[0]!.get(CALLER_SESSION_HEADER)).toBeNull()
    expect(seen[1]!.get(CALLER_SESSION_HEADER)).toBe("s1")
    expect(seen[1]!.get(CALLER_NODE_HEADER)).toBe("@me/notes")
    expect(seen[1]!.get("authorization")).toBe("Bearer x")
  })

  it("overwrites a caller header the connection config tries to pin", async () => {
    let seen: Headers | undefined
    const base = (async (_url: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers)
      return new Response("{}")
    }) as typeof fetch
    await withCallHeaders({ [CALLER_SESSION_HEADER]: "real" }, () =>
      callerForwardingFetch(base)("http://127.0.0.1:1/mcp", { headers: { [CALLER_SESSION_HEADER]: "forged" } }),
    )
    expect(seen!.get(CALLER_SESSION_HEADER)).toBe("real")
  })

  it("forwards only to loopback http/sse servers, or those that opted in", () => {
    expect(shouldForwardCallerHeaders({ type: "http", url: "http://127.0.0.1:8080/mcp" })).toBe(true)
    expect(shouldForwardCallerHeaders({ type: "sse", url: "http://localhost:8080/sse" })).toBe(true)
    expect(shouldForwardCallerHeaders({ type: "http", url: "http://[::1]:8080/mcp" })).toBe(true)
    expect(shouldForwardCallerHeaders({ type: "http", url: "https://api.example.com/mcp" })).toBe(false)
    expect(shouldForwardCallerHeaders({ type: "http", url: "https://api.example.com/mcp" }, true)).toBe(true)
    expect(shouldForwardCallerHeaders({ type: "stdio", command: "x" }, true)).toBe(false)
    expect(shouldForwardCallerHeaders({ type: "http", url: "https://localhost.evil.test/mcp" })).toBe(false)
  })
})

describe("the headers reach a real http MCP server", () => {
  let http: Server
  let url: string
  const received: IncomingHttpHeaders[] = []

  beforeEach(async () => {
    received.length = 0
    http = createServer(async (req, res) => {
      const server = new McpServer({ name: "echo", version: "0.0.0" })
      server.tool("whoami", "echo the caller headers", {}, async (_args, extra) => {
        received.push((extra as { requestInfo?: { headers: IncomingHttpHeaders } }).requestInfo?.headers ?? {})
        return { content: [{ type: "text" as const, text: "ok" }] }
      })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await server.connect(transport)
      await transport.handleRequest(req, res)
    })
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r))
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`
  })
  afterEach(async () => {
    await new Promise<void>((r) => http.close(() => r()))
  })

  it("sends the headers of the call that is in flight and no others", async () => {
    const client = await openMcpClient({ type: "http", url }, { label: "echo", forwardCallHeaders: true })
    await withCallHeaders({ [CALLER_SESSION_HEADER]: SESSION.notes, [CALLER_NODE_HEADER]: NOTES_ID }, () =>
      client.callTool({ name: "whoami", arguments: {} }),
    )
    await client.callTool({ name: "whoami", arguments: {} })
    await client.close()
    const calls = received.filter((h) => h[CALLER_SESSION_HEADER] !== undefined)
    expect(calls).toHaveLength(1)
    expect(calls[0]![CALLER_SESSION_HEADER]).toBe(SESSION.notes)
    expect(calls[0]![CALLER_NODE_HEADER]).toBe(NOTES_ID)
  })

  it("a connection not opened for forwarding sends nothing", async () => {
    const client = await openMcpClient({ type: "http", url }, { label: "echo" })
    await withCallHeaders({ [CALLER_SESSION_HEADER]: SESSION.notes }, () =>
      client.callTool({ name: "whoami", arguments: {} }),
    )
    await client.close()
    expect(received.some((h) => h[CALLER_SESSION_HEADER] !== undefined)).toBe(false)
  })
})
