/**
 * Unit coverage for the `adapter_list` MCP tool (agent-tools.ts), focused on
 * the `summary` projection added for app-UI runner pickers (`@agentproto/
 * app-client`'s `mountRunnerSelect`) — the default (unset/false) payload
 * forwards the injected `listAgentAdapters` result verbatim, but the daemon's
 * full manifest projection can run to hundreds of KB, far heavier than a
 * picker needs. Mirrors harness-capabilities-tool.test.ts's
 * createMcpServer + InMemoryTransport pattern.
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AdapterListEntry, AgentAdapterLister } from "../http-server.js"

async function harness(listAgentAdapters?: AgentAdapterLister) {
  const registry = createSessionsRegistry({ persist: false })
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerAgentTools(server, {
    registry,
    ...(listAgentAdapters ? { listAgentAdapters } : {}),
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return { client, close: async () => client.close() }
}

function parseAdapters(result: unknown): unknown[] {
  const content = (result as { content: Array<{ text: string }> }).content
  return (JSON.parse(content[0]!.text) as { adapters: unknown[] }).adapters
}

const FULL_ADAPTER: AdapterListEntry & { commands: unknown[]; modelDetails: unknown[] } = {
  slug: "hermes",
  name: "Hermes",
  version: "1.2.3",
  description: "A very long description that a picker never needs to render.",
  protocol: "acp",
  streaming: true,
  packageName: "@agentproto/adapter-hermes",
  modes: [],
  models: ["z-ai/glm-5.2", "gpt-5"],
  commands: [{ id: "compact", description: "Compact context" }],
  modelDetails: [{ id: "z-ai/glm-5.2", provider: "openrouter" }],
}

describe("adapter_list", () => {
  it("reports 'not enabled' when no lister is wired", async () => {
    const h = await harness()
    const result = await h.client.callTool({ name: "adapter_list", arguments: {} })
    expect((result as { isError?: boolean }).isError).toBe(true)
    await h.close()
  })

  it("forwards the full lister payload unchanged when summary is unset", async () => {
    const h = await harness(async () => [FULL_ADAPTER])
    const result = await h.client.callTool({ name: "adapter_list", arguments: {} })
    const adapters = parseAdapters(result)
    expect(adapters).toEqual([FULL_ADAPTER])
    await h.close()
  })

  it("projects to { slug, name, version, protocol, models } when summary: true", async () => {
    const h = await harness(async () => [FULL_ADAPTER])
    const result = await h.client.callTool({
      name: "adapter_list",
      arguments: { summary: true },
    })
    const adapters = parseAdapters(result)
    expect(adapters).toEqual([
      { slug: "hermes", name: "Hermes", version: "1.2.3", protocol: "acp", models: ["z-ai/glm-5.2", "gpt-5"] },
    ])
    await h.close()
  })

  it("summary defaults models to [] when the lister didn't populate it", async () => {
    const { models, ...withoutModels } = FULL_ADAPTER
    void models
    const h = await harness(async () => [withoutModels as AdapterListEntry])
    const result = await h.client.callTool({
      name: "adapter_list",
      arguments: { summary: true },
    })
    const adapters = parseAdapters(result)
    expect(adapters).toEqual([
      { slug: "hermes", name: "Hermes", version: "1.2.3", protocol: "acp", models: [] },
    ])
    await h.close()
  })

  it("full: true aliases summary: false (PR-8 PLAN §7 Q4) — the summary projection is opted out", async () => {
    const h = await harness(async () => [FULL_ADAPTER])
    const result = await h.client.callTool({
      name: "adapter_list",
      arguments: { full: true },
    })
    // full:true alone → full payload, byte-shape identical to summary:false.
    expect(parseAdapters(result)).toEqual([FULL_ADAPTER])
    await h.close()

    const h2 = await harness(async () => [FULL_ADAPTER])
    // full:true beats summary:true when both are passed.
    const result2 = await h2.client.callTool({
      name: "adapter_list",
      arguments: { summary: true, full: true },
    })
    expect(parseAdapters(result2)).toEqual([FULL_ADAPTER])
    await h2.close()
  })

  it("page-walk with limit=2 covers exactly the unpaginated list; default call unchanged (PR-8)", async () => {
    const three: AdapterListEntry[] = [
      FULL_ADAPTER,
      { ...FULL_ADAPTER, slug: "claude-code", name: "Claude Code" },
      { ...FULL_ADAPTER, slug: "aider", name: "Aider" },
    ]
    const h = await harness(async () => three)

    // Default call unchanged: the { adapters } envelope, full projection,
    // no page fields.
    const unpaginated = parseAdapters(await h.client.callTool({ name: "adapter_list", arguments: {} }))
    expect(unpaginated).toEqual(three)

    // Page-walk over the FULL projection: union == unpaginated.
    const union: Array<{ slug: string }> = []
    let cursor: string | undefined
    do {
      const raw = JSON.parse(
        (
          (await h.client.callTool({
            name: "adapter_list",
            arguments: { limit: 2, ...(cursor ? { cursor } : {}) },
          })) as { content: Array<{ text: string }> }
        ).content[0]!.text,
      ) as { items: Array<{ slug: string }>; total: number; nextCursor?: string }
      expect(raw.total).toBe(3)
      union.push(...raw.items)
      cursor = raw.nextCursor
    } while (cursor)
    expect(union.map(a => a.slug)).toEqual(three.map(a => a.slug))

    // Page-walk over the summary projection: union == summary rows.
    const summaryUnion: Array<{ slug: string }> = []
    let summaryCursor: string | undefined
    do {
      const raw = JSON.parse(
        (
          (await h.client.callTool({
            name: "adapter_list",
            arguments: { summary: true, limit: 1, ...(summaryCursor ? { cursor: summaryCursor } : {}) },
          })) as { content: Array<{ text: string }> }
        ).content[0]!.text,
      ) as { items: Array<{ slug: string }>; nextCursor?: string }
      summaryUnion.push(...raw.items)
      summaryCursor = raw.nextCursor
    } while (summaryCursor)
    expect(summaryUnion.map(a => a.slug)).toEqual(three.map(a => a.slug))
    // Summary rows carry only the projection fields.
    expect(Object.keys(summaryUnion[0]!).sort()).toEqual(["models", "name", "protocol", "slug", "version"])

    await h.close()
  })
})
