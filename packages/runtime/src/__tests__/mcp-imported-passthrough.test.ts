/**
 * `/mcp/imported/<id>` — the per-import MCP passthrough (PLAN D phase 1):
 * a real streamable-HTTP MCP server that proxies `tools/list`/`tools/call`
 * of ONE imported server via `McpProxyRegistry`, under the upstream's OWN
 * (unprefixed) tool names — so a bundle can mount it into ANY harness as a
 * first-class MCP server, instead of the two-step `mcp_imported_tool_list`/
 * `mcp_imported_call` indirection `mcp_imported_call` etc. stay for a
 * session already on the daemon's own `/mcp`.
 */

import { describe, it, expect, vi } from "vitest"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createImportedCallGuard } from "../imported-call-gate.js"
import { McpProxyRegistry } from "../mcp-proxy.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { ProxyAliasSummary, ProxyCallOutcome, ProxyToolDescriptor } from "../mcp-proxy.js"

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
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

/** A fake registry backing exactly one import: alias "fake-mcp", id "fake:mcp",
 *  one tool `ping` that echoes back whatever `arguments.text` was sent
 *  (extra tools can be injected for the deny/allow filter tests — a filtered
 *  tool must be rejected BEFORE the upstream is ever asked). */
function fakeProxy(extraTools: ProxyToolDescriptor[] = []): McpProxyRegistry {
  const aliases: ProxyAliasSummary[] = [
    {
      alias: "fake-mcp",
      importId: "fake:mcp",
      source: "workspace",
      type: "stdio",
      status: "connected",
      toolCount: 1 + extraTools.length,
    },
  ]
  const tools: ProxyToolDescriptor[] = [
    { name: "ping", description: "echoes text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    ...extraTools,
  ]
  const knownNames = new Set(tools.map(t => t.name))
  return {
    async listAliases() {
      return aliases
    },
    async listTools(alias: string) {
      if (alias !== "fake:mcp" && alias !== "fake-mcp") return { ok: false, error: `unknown alias "${alias}"` }
      return { ok: true, tools }
    },
    async callTool(alias: string, toolName: string, args: unknown): Promise<ProxyCallOutcome> {
      if (alias !== "fake:mcp" && alias !== "fake-mcp") return { ok: false, error: `unknown alias "${alias}"` }
      if (!knownNames.has(toolName)) return { ok: false, error: `no such tool "${toolName}"` }
      const text = (args as { text?: string } | undefined)?.text ?? toolName
      return { ok: true, result: { content: [{ type: "text", text: `pong:${text}` }] } }
    },
    async closeAll() {},
  } as unknown as McpProxyRegistry
}

describe("/mcp/imported/<id> — per-import passthrough (PLAN D phase 1)", () => {
  it("lists the upstream's own (unprefixed) tool names and forwards a call through", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      mcpProxy: fakeProxy(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const client = new Client({ name: "imported-passthrough-test", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp/imported/fake:mcp`),
      )
      await client.connect(transport)
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).toEqual(["ping"])

      const result = await client.callTool({ name: "ping", arguments: { text: "hi" } })
      expect(result.content).toEqual([{ type: "text", text: "pong:hi" }])
      await client.close()
    } finally {
      await http.stop()
    }
  })

  it("also resolves by alias (not just the import id)", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      mcpProxy: fakeProxy(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const client = new Client({ name: "imported-passthrough-alias-test", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp/imported/fake-mcp`),
      )
      await client.connect(transport)
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).toEqual(["ping"])
      await client.close()
    } finally {
      await http.stop()
    }
  })

  it("a failed upstream tool call surfaces as an MCP error result, never a hang", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      mcpProxy: fakeProxy(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const client = new Client({ name: "imported-passthrough-error-test", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp/imported/fake:mcp`),
      )
      await client.connect(transport)
      const result = await client.callTool({ name: "does-not-exist", arguments: {} })
      expect(result.isError).toBe(true)
      await client.close()
    } finally {
      await http.stop()
    }
  })

  it("404s an unknown/removed import id", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      mcpProxy: fakeProxy(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp/imported/does-not-exist`)
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toBe("import_not_found")
    } finally {
      await http.stop()
    }
  })

  it("501s when the daemon has no MCP proxy configured", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp/imported/anything`)
      expect(res.status).toBe(501)
    } finally {
      await http.stop()
    }
  })
})

describe("/mcp/imported/<id> — denyTools/allowTools query filter (#2050)", () => {
  const secretTool: ProxyToolDescriptor = {
    name: "secret_tool",
    description: "must be hideable",
    inputSchema: { type: "object" },
  }

  async function startWith(extraTools: ProxyToolDescriptor[]) {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      mcpProxy: fakeProxy(extraTools),
      meta: { workspace: process.cwd(), registered: [] },
    })
    return { http, port }
  }

  it("denyTools hides the tool from tools/list and REJECTS tools/call with a JSON-RPC error", async () => {
    const { http, port } = await startWith([secretTool])
    try {
      const client = new Client({ name: "imported-deny-test", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp/imported/fake:mcp?denyTools=secret_tool`),
      )
      await client.connect(transport)
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).toEqual(["ping"])
      // Enforcement, not just hiding: the call must be a JSON-RPC error, not
      // an upstream round-trip (the fake proxy would echo `pong:secret_tool`).
      let rpcError: unknown
      try {
        await client.callTool({ name: "secret_tool", arguments: { text: "x" } })
      } catch (err) {
        rpcError = err
      }
      expect(rpcError).toBeDefined()
      expect((rpcError as Error).message).toContain("secret_tool")
      await client.close()
    } finally {
      await http.stop()
    }
  })

  it("allowTools keeps only the allowlisted tool and rejects the rest", async () => {
    const { http, port } = await startWith([secretTool])
    try {
      const client = new Client({ name: "imported-allow-test", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp/imported/fake:mcp?allowTools=ping`),
      )
      await client.connect(transport)
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).toEqual(["ping"])
      await expect(
        client.callTool({ name: "secret_tool", arguments: {} }),
      ).rejects.toThrow()
      await client.close()
    } finally {
      await http.stop()
    }
  })

  it("deny applied after allow: a name on both lists is excluded", async () => {
    const { http, port } = await startWith([secretTool])
    try {
      const client = new Client({ name: "imported-both-test", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(
        new URL(
          `http://127.0.0.1:${port}/mcp/imported/fake:mcp?allowTools=${encodeURIComponent("ping,secret_tool")}&denyTools=secret_tool`,
        ),
      )
      await client.connect(transport)
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).toEqual(["ping"])
      await expect(
        client.callTool({ name: "secret_tool", arguments: {} }),
      ).rejects.toThrow()
      await client.close()
    } finally {
      await http.stop()
    }
  })

  it("no params = unchanged behaviour (both tools listed and callable)", async () => {

    const { http, port } = await startWith([secretTool])
    try {
      const client = new Client({ name: "imported-nofilter-test", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp/imported/fake:mcp`),
      )
      await client.connect(transport)
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).toEqual(["ping", "secret_tool"])
      const result = await client.callTool({ name: "secret_tool", arguments: { text: "hi" } })
      expect(result.content).toEqual([{ type: "text", text: "pong:hi" }])
      await client.close()
    } finally {
      await http.stop()
    }
  })
})

describe("/mcp/imported/<id> - caller attribution", () => {
  const CALLER_HEADER = "x-agentproto-caller-session-id"

  function recordingProxy(): {
    proxy: McpProxyRegistry
    callTool: ReturnType<typeof vi.fn>
  } {
    const aliases: ProxyAliasSummary[] = [
      {
        alias: "fake-mcp",
        importId: "fake:mcp",
        source: "workspace",
        type: "stdio",
        status: "connected",
        toolCount: 1,
      },
    ]
    const tools: ProxyToolDescriptor[] = [
      {
        name: "ping",
        description: "echoes text back",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      },
    ]
    const callTool = vi.fn(
      async (_alias: string, _toolName: string, _args: unknown): Promise<ProxyCallOutcome> => ({
        ok: true,
        result: { content: [{ type: "text", text: "pong" }] },
      }),
    )
    const proxy = {
      async listAliases() {
        return aliases
      },
      async listTools() {
        return { ok: true as const, tools }
      },
      callTool,
      async closeAll() {},
    } as unknown as McpProxyRegistry
    return { proxy, callTool }
  }

  async function withServer(
    proxy: McpProxyRegistry,
    run: (port: number) => Promise<void>,
  ): Promise<void> {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      mcpProxy: proxy,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      await run(port)
    } finally {
      await http.stop()
    }
  }

  async function callPing(
    port: number,
    url: string,
    headers?: Record<string, string>,
  ): Promise<{ isError?: boolean; content?: unknown }> {
    const client = new Client({ name: "imported-attribution-test", version: "0.0.1" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        ...(headers ? { requestInit: { headers } } : {}),
      }),
    )
    try {
      return (await client.callTool({ name: "ping", arguments: { text: "hi" } })) as {
        isError?: boolean
        content?: unknown
      }
    } finally {
      await client.close()
    }
  }

  it("passes the ?callerSessionId= query claim to the proxy call", async () => {
    const { proxy, callTool } = recordingProxy()
    await withServer(proxy, async port => {
      await callPing(port, `http://127.0.0.1:${port}/mcp/imported/fake:mcp?callerSessionId=sess_x`)
    })
    expect(callTool).toHaveBeenCalledTimes(1)
    expect(callTool.mock.calls[0]?.[3]).toEqual({ callerSessionId: "sess_x" })
  })

  it("passes a trusted identity header claim to the proxy call", async () => {
    const { proxy, callTool } = recordingProxy()
    await withServer(proxy, async port => {
      await callPing(port, `http://127.0.0.1:${port}/mcp/imported/fake:mcp`, {
        [CALLER_HEADER]: "sess_header",
      })
    })
    expect(callTool.mock.calls[0]?.[3]).toEqual({ callerSessionId: "sess_header" })
  })

  it("passes no context for a host call", async () => {
    const { proxy, callTool } = recordingProxy()
    await withServer(proxy, async port => {
      await callPing(port, `http://127.0.0.1:${port}/mcp/imported/fake:mcp`)
    })
    expect(callTool.mock.calls[0]).toHaveLength(3)
  })

  it("does not trust a bare identity header on a proxied request", async () => {
    const { proxy, callTool } = recordingProxy()
    await withServer(proxy, async port => {
      await callPing(port, `http://127.0.0.1:${port}/mcp/imported/fake:mcp`, {
        [CALLER_HEADER]: "sess_spoofed",
        "x-forwarded-for": "203.0.113.9",
      })
    })
    expect(callTool.mock.calls[0]).toHaveLength(3)
  })

  describe("end to end with createImportedCallGuard", () => {
    function writeHooks(workspace: string): void {
      mkdirSync(join(workspace, ".agentproto"), { recursive: true })
      writeFileSync(
        join(workspace, ".agentproto", "hooks.json"),
        JSON.stringify({
          version: 1,
          rules: [
            { id: "hold-ping", plane: "semantic", match: { tool: "ping" }, action: "hold" },
          ],
        }),
      )
    }

    function guardProxy(workspace: string): {
      proxy: McpProxyRegistry
      upstream: ReturnType<typeof vi.fn>
      permission: ReturnType<typeof vi.fn>
    } {
      const upstream = vi.fn(async () => ({ content: [{ type: "text", text: "pong" }] }))
      const permission = vi.fn(async () => ({ decision: "deny", optionId: "reject_once" }))
      const proxy = new McpProxyRegistry()
      vi.spyOn(proxy as never, "listAliases" as never).mockResolvedValue([
        {
          alias: "fake-mcp",
          importId: "fake:mcp",
          source: "workspace",
          type: "stdio",
          status: "connected",
          toolCount: 1,
        },
      ] as never)
      vi.spyOn(proxy as never, "listTools" as never).mockResolvedValue({
        ok: true,
        tools: [{ name: "ping", inputSchema: { type: "object" } }],
      } as never)
      vi.spyOn(proxy as never, "connectIfNeeded" as never).mockImplementation((async () => ({
        entry: {},
        client: { callTool: upstream },
        tools: [],
        lastError: null,
      })) as never)
      proxy.setCallGuard(
        createImportedCallGuard({
          registry: {
            get: (id: string) => (id === "sess_x" ? { id, cwd: workspace } : undefined),
            requestToolPermission: permission,
          } as never,
          workspace,
          timeoutMs: 500,
        }),
      )
      return { proxy, upstream, permission }
    }

    it("attributes a held call to the caller session named by the query", async () => {
      const workspace = mkdtempSync(join(tmpdir(), "imported-attribution-"))
      try {
        writeHooks(workspace)
        const { proxy, upstream, permission } = guardProxy(workspace)
        await withServer(proxy, async port => {
          const result = await callPing(
            port,
            `http://127.0.0.1:${port}/mcp/imported/fake:mcp?callerSessionId=sess_x`,
          )
          expect(result.isError).toBe(true)
        })
        expect(permission).toHaveBeenCalledTimes(1)
        expect(permission.mock.calls[0]?.[0]).toMatchObject({
          sessionId: "sess_x",
          toolName: "ping",
        })
        expect(upstream).not.toHaveBeenCalled()
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    })

    it("keeps a no-claim call a host call (no sessionId on the approval)", async () => {
      const workspace = mkdtempSync(join(tmpdir(), "imported-attribution-"))
      try {
        writeHooks(workspace)
        const { proxy, upstream, permission } = guardProxy(workspace)
        await withServer(proxy, async port => {
          const result = await callPing(port, `http://127.0.0.1:${port}/mcp/imported/fake:mcp`)
          expect(result.isError).toBe(true)
        })
        expect(permission).toHaveBeenCalledTimes(1)
        expect(permission.mock.calls[0]?.[0]?.sessionId).toBeUndefined()
        expect(upstream).not.toHaveBeenCalled()
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    })

    it("refuses an unknown caller session before anything reaches the upstream", async () => {
      const workspace = mkdtempSync(join(tmpdir(), "imported-attribution-"))
      try {
        writeHooks(workspace)
        const { proxy, upstream, permission } = guardProxy(workspace)
        await withServer(proxy, async port => {
          const result = await callPing(
            port,
            `http://127.0.0.1:${port}/mcp/imported/fake:mcp?callerSessionId=sess_ghost`,
          )
          expect(result.isError).toBe(true)
          expect(JSON.stringify(result.content)).toContain("not known")
        })
        expect(permission).not.toHaveBeenCalled()
        expect(upstream).not.toHaveBeenCalled()
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    })
  })
})
