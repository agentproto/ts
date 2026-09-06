/**
 * Minimal MCP-transport coverage for the PR-8 additive limit/cursor
 * pagination on three session-tools list verbs with no prior dedicated
 * surface test: `mcp_discovered_list`, `mcp_imported_list`, and
 * `session_queue_list`. Mirrors harness-preset-tools.test.ts's real-McpServer
 * + InMemoryTransport + temp-HOME isolation; `discoverMcps` is stubbed so no
 * host agent-tooling config is read.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { AgentSessionLike } from "../sessions.js"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import { saveImportedMcps } from "../mcp-imports.js"
import type { DiscoveredMcp } from "../mcp-discovery.js"

vi.mock("../mcp-discovery.js", () => ({
  discoverMcps: async (): Promise<DiscoveredMcp[]> => [
    { id: "claude-code:global:chrome-devtools", source: "claude-code", scope: "global", name: "chrome-devtools", type: "stdio", command: "npx", args: ["chrome-devtools-mcp"] },
    { id: "cursor:global:github", source: "cursor", scope: "global", name: "github", type: "http", url: "https://mcp.example.test/github" },
    { id: "goose:global:fetch", source: "goose", scope: "global", name: "fetch", type: "stdio", command: "fetch-mcp" },
  ],
}))

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

async function connect(register: (server: McpServer) => void) {
  const server = new McpServer({ name: "session-misc-lists-test-server", version: "0.0.0" })
  register(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "session-misc-lists-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client, close: async () => client.close() }
}

let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-session-misc-lists-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe("mcp_discovered_list pagination (PR-8)", () => {
  it("page-walk with limit=2 covers exactly the unpaginated list; default call unchanged", async () => {
    const { client, close } = await connect(server => registerSessionTools(server, { registry: createSessionsRegistry({ persist: false }), workspace: process.cwd() }))

    // Default call unchanged: the { mcps } envelope, no page fields.
    const unpaginated = parse(await client.callTool({ name: "mcp_discovered_list", arguments: {} }))
    expect(unpaginated.mcps.map((m: { id: string }) => m.id)).toEqual([
      "claude-code:global:chrome-devtools",
      "cursor:global:github",
      "goose:global:fetch",
    ])
    expect(unpaginated.items).toBeUndefined()
    expect(unpaginated.total).toBeUndefined()

    // Page-walk: the union of pages equals the unpaginated list exactly.
    const union: string[] = []
    let cursor: string | undefined
    do {
      const page = parse(
        await client.callTool({
          name: "mcp_discovered_list",
          arguments: { limit: 2, ...(cursor ? { cursor } : {}) },
        }),
      )
      expect(page.total).toBe(3)
      union.push(...page.items.map((m: { id: string }) => m.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(union).toEqual(unpaginated.mcps.map((m: { id: string }) => m.id))

    await close()
  })
})

describe("mcp_imported_list pagination (PR-8)", () => {
  it("page-walk with limit=2 covers exactly the unpaginated list; default call unchanged", async () => {
    await saveImportedMcps({
      version: 1,
      imports: [
        { id: "claude-code:global:chrome-devtools", alias: "chrome", addedAt: "2026-07-22T10:00:00.000Z", snapshot: { id: "claude-code:global:chrome-devtools", source: "claude-code", scope: "global", name: "chrome-devtools", type: "stdio" } },
        { id: "cursor:global:github", alias: "github", addedAt: "2026-07-22T10:01:00.000Z", snapshot: { id: "cursor:global:github", source: "cursor", scope: "global", name: "github", type: "http" } },
        { id: "goose:global:fetch", alias: "fetch", addedAt: "2026-07-22T10:02:00.000Z", snapshot: { id: "goose:global:fetch", source: "goose", scope: "global", name: "fetch", type: "stdio" } },
      ],
    })
    const { client, close } = await connect(server => registerSessionTools(server, { registry: createSessionsRegistry({ persist: false }), workspace: process.cwd() }))

    // Default call unchanged: the persisted { version, imports } config, no page fields.
    const unpaginated = parse(await client.callTool({ name: "mcp_imported_list", arguments: {} }))
    expect(unpaginated.version).toBe(1)
    expect(unpaginated.imports.map((e: { id: string }) => e.id)).toEqual([
      "claude-code:global:chrome-devtools",
      "cursor:global:github",
      "goose:global:fetch",
    ])
    expect(unpaginated.items).toBeUndefined()
    expect(unpaginated.total).toBeUndefined()

    // Page-walk: the union of pages equals the unpaginated list exactly.
    const union: string[] = []
    let cursor: string | undefined
    do {
      const page = parse(
        await client.callTool({
          name: "mcp_imported_list",
          arguments: { limit: 2, ...(cursor ? { cursor } : {}) },
        }),
      )
      expect(page.total).toBe(3)
      union.push(...page.items.map((e: { id: string }) => e.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(union).toEqual(unpaginated.imports.map((e: { id: string }) => e.id))

    await close()
  })
})

describe("session_queue_list pagination (PR-8)", () => {
  it("page-walk with limit=2 covers exactly the unpaginated queue; default call unchanged", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const agent: AgentSessionLike = {
      sessionId: "queue-list-session",
      async *send() {
        await new Promise(() => {})
      },
      async cancel() {},
      async close() {},
    }
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })
    const firstPromise = registry.sendPrompt(desc.id, "first")
    await Promise.resolve()
    await registry.enqueuePrompt(desc.id, "s1", { queue: true })
    await registry.enqueuePrompt(desc.id, "s2", { queue: true })
    await registry.enqueuePrompt(desc.id, "s3", { queue: true })
    void firstPromise.catch(() => undefined)

    const { client, close } = await connect(server => registerSessionTools(server, { registry, workspace: process.cwd() }))

    // Default call unchanged: the { sessionId, queue } envelope, no page fields.
    const unpaginated = parse(await client.callTool({ name: "session_queue_list", arguments: { sessionId: desc.id } }))
    expect(unpaginated.sessionId).toBe(desc.id)
    expect(unpaginated.queue.map((q: { preview: string }) => q.preview)).toEqual(["s1", "s2", "s3"])
    expect(unpaginated.items).toBeUndefined()
    expect(unpaginated.total).toBeUndefined()

    // Page-walk: the union of pages equals the unpaginated queue exactly.
    const union: string[] = []
    let cursor: string | undefined
    do {
      const page = parse(
        await client.callTool({
          name: "session_queue_list",
          arguments: { sessionId: desc.id, limit: 2, ...(cursor ? { cursor } : {}) },
        }),
      )
      expect(page.total).toBe(3)
      union.push(...page.items.map((q: { preview: string }) => q.preview))
      cursor = page.nextCursor
    } while (cursor)
    expect(union).toEqual(["s1", "s2", "s3"])

    await close()
    registry.kill(desc.id)
    registry.shutdown()
  })
})
