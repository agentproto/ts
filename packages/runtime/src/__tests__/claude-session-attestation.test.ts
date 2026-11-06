/**
 * The stdio bridge attests the real Claude Code session with
 * `x-agentproto-claude-session`. On a request that carries the shared
 * `claude-desktop` identity (or none), the daemon resolves the caller to the
 * external row `cc:<id>` (the row the hooks touch). Any other identity, an
 * invalid header and an absent header leave behaviour unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, type AgentSessionLike, type SessionsRegistry } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

/** The wire name, spelled out so the test states the contract. */
const HEADER = "x-agentproto-claude-session"

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

const noopConversations = (): ConversationStore => ({
  async open() {},
  async appendTurn() {},
  async read() {
    return { meta: {} as never, turns: [] }
  },
  async list() {
    return []
  },
  pathFor: (id: string) => id,
})
const noopHeartbeat = (): HeartbeatRunner => ({ start() {}, stop() {}, async fireNow() {} })

async function resolveCaller(
  query: string,
  headers: Record<string, string>,
  registry?: SessionsRegistry,
): Promise<string | undefined> {
  const seen: (string | undefined)[] = []
  const mcpServerFactory = async (_deny?: ReadonlySet<string>, callerSessionId?: string) => {
    seen.push(callerSessionId)
    const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
    server.tool("probe", "probe", {}, async () => ({ content: [{ type: "text" as const, text: "ok" }] }))
    return server
  }
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
    ...(registry ? { sessions: registry } : {}),
  })
  try {
    const client = new Client({ name: "attest-test", version: "0.0.1" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp${query}`), {
        requestInit: { headers },
      }),
    )
    await client.listTools()
    await client.close()
    return seen[seen.length - 1]
  } finally {
    await http.stop()
  }
}

const DESKTOP = "?callerSessionId=claude-desktop&host=claude-desktop"

describe("daemon: caller resolution from the attested Claude Code session", () => {
  it("shared claude-desktop identity + header resolves to cc:<id> and touches that row", async () => {
    const registry = createSessionsRegistry({ persist: false })
    expect(await resolveCaller(DESKTOP, { [HEADER]: "abc-123" }, registry)).toBe("cc:abc-123")
    const row = registry.get("cc:abc-123")
    expect(row?.kind).toBe("external")
  })

  it("no identity in the URL + header resolves to cc:<id>", async () => {
    expect(await resolveCaller("", { [HEADER]: "abc-123" })).toBe("cc:abc-123")
  })

  it("no header: the shared identity is unchanged", async () => {
    expect(await resolveCaller(DESKTOP, {})).toBe("claude-desktop")
    expect(await resolveCaller("", {})).toBeUndefined()
  })

  it("an invalid header is ignored", async () => {
    for (const bad of ["bad id!", "a/b", "x".repeat(129), "cc:abc"]) {
      expect(await resolveCaller(DESKTOP, { [HEADER]: bad }), bad).toBe("claude-desktop")
    }
  })

  it("never overrides another claimed identity", async () => {
    expect(await resolveCaller("?callerSessionId=sess_real", { [HEADER]: "abc-123" })).toBe("sess_real")
    expect(await resolveCaller("?callerSessionId=cc:other&host=claude-desktop", { [HEADER]: "abc-123" })).toBe("cc:other")
  })
})

// ── tool level: agent_start / message_parent for a cc: caller ───────────────

const fakeSession = (): AgentSessionLike => ({
  sessionId: "adapter_attest_test",
  // eslint-disable-next-line require-yield
  async *send() {},
  async cancel() {},
  async close() {},
})

const json = (result: unknown): any => {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  return JSON.parse(content!.find(c => c.type === "text")!.text!)
}

async function connectTools(registry: SessionsRegistry, callerSessionId: string, spawn = true) {
  const startSession = vi.fn(async () => fakeSession())
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession: startSession as any,
    commandPreview: "mock-adapter",
  })
  const server = new McpServer({ name: "attest", version: "0.0.0" })
  registerAgentTools(server, { registry, ...(spawn ? { resolveAgentAdapter } : {}), callerSessionId })
  const [c, s] = InMemoryTransport.createLinkedPair()
  await server.connect(s)
  const client = new Client({ name: "attest-client", version: "0.0.0" })
  await client.connect(c)
  return (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean }>
}

let previousHome: string | undefined
let home: string
beforeEach(async () => {
  previousHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-attest-"))
  process.env.HOME = home
})
afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

describe("tools for a caller attested as cc:<id>", () => {
  const setup = () => {
    const registry = createSessionsRegistry({ persist: false })
    registry.touchExternal({ id: "claude-desktop", host: "claude-desktop" })
    registry.touchExternal({ id: "cc:abc", host: "claude-desktop" })
    return registry
  }

  it("agent_start attaches the child under cc:<id> with no declared parent, and message_parent lands on that row", async () => {
    const registry = setup()
    const call = await connectTools(registry, "cc:abc")
    const res = await call("agent_start", { adapter: "mock", cwd: "/tmp" })
    expect(res.isError).toBeFalsy()
    const child = registry.get(json(res).id)!
    expect(child.parentSessionId).toBe("cc:abc")

    const spy = vi.spyOn(registry, "sendMessage")
    const asChild = await connectTools(registry, child.id, false)
    expect((await asChild("message_parent", { message: "done" })).isError).toBeFalsy()
    const targets = spy.mock.calls.map(c => (c[0] as { to: string }).to)
    expect(targets).toContain("cc:abc")
    expect(targets).not.toContain("claude-desktop")
  })

  it("a declared parent equal to the attested row is accepted (no regression)", async () => {
    const registry = setup()
    const call = await connectTools(registry, "cc:abc")
    const res = await call("agent_start", { adapter: "mock", cwd: "/tmp", parent: "cc:abc" })
    expect(res.isError).toBeFalsy()
    expect(registry.get(json(res).id)!.parentSessionId).toBe("cc:abc")
  })

  it("a declared parent that differs from the attested row is refused", async () => {
    const registry = setup()
    registry.touchExternal({ id: "cc:other", host: "claude-desktop" })
    const call = await connectTools(registry, "cc:abc")
    const res = await call("agent_start", { adapter: "mock", cwd: "/tmp", parent: "cc:other" })
    expect(res.isError).toBe(true)
  })
})
