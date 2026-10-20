/**
 * Unit coverage for the `adapter_list` MCP tool (agent-tools.ts). The tool
 * is migrated onto the AIP contract layer (defineTool + implementTool +
 * toMcpTool) with the shared `paginated()` transformer: COMPACT BY DEFAULT
 * and budget-safe (slug/name/version/protocol + installed + modelCount —
 * the model-id array is what blew past the MCP result cap and got callers
 * a truncated stub they misread as an empty list), with the full manifest
 * echo behind `full: true` / `compact: false`. Mirrors harness-capabilities-tool.test.ts's
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

  it("default output is the COMPACT projection ({ slug, name, version, protocol, installed, modelCount })", async () => {
    const h = await harness(async () => [FULL_ADAPTER])
    const result = await h.client.callTool({ name: "adapter_list", arguments: {} })
    const adapters = parseAdapters(result)
    expect(adapters).toEqual([
      { slug: "hermes", name: "Hermes", version: "1.2.3", protocol: "acp", installed: true, modelCount: 2 },
    ])
    // And it's small: only the projection keys survive.
    expect(Object.keys(adapters[0] as object).sort()).toEqual(
      ["installed", "modelCount", "name", "protocol", "slug", "version"],
    )
    await h.close()
  })

  it("compact `installed` mirrors the lister's status: supported = not installed, ready/absent = installed", async () => {
    const h = await harness(async () => [
      { ...FULL_ADAPTER, slug: "installed-ad", status: "ready" as const },
      { ...FULL_ADAPTER, slug: "catalog-ad", status: "supported" as const },
      { ...FULL_ADAPTER, slug: "legacy-ad" },
    ])
    const result = await h.client.callTool({ name: "adapter_list", arguments: {} })
    const adapters = parseAdapters(result) as Array<{ slug: string; installed: boolean }>
    expect(adapters.map(a => [a.slug, a.installed])).toEqual([
      ["installed-ad", true],
      ["catalog-ad", false],
      ["legacy-ad", true],
    ])
    await h.close()
  })

  it("the COMPACT default fits the MCP result budget even with a runaway model list (the truncated-stub regression)", async () => {
    // A real daemon's merged listing exceeded 100 KB (the cap in
    // mcp-server/to-mcp-tool.ts) purely through the models arrays, and the
    // whole tool call was replaced by a `{ truncated: true }` stub.
    const big: AdapterListEntry = { ...FULL_ADAPTER, models: Array.from({ length: 20_000 }, (_, i) => `vendor/model-${i}`) }
    expect(JSON.stringify(big).length).toBeGreaterThan(100_000)
    const h = await harness(async () => [big, { ...big, slug: "claude-code" }])
    const raw = JSON.parse(
      ((await h.client.callTool({ name: "adapter_list", arguments: {} })) as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { adapters: unknown[]; truncated?: boolean }
    expect(raw.truncated).toBeUndefined()
    expect(raw.adapters).toHaveLength(2)
    expect((raw.adapters[0] as { modelCount: number }).modelCount).toBe(20_000)
    // full: true is the escape hatch — and it's exactly the call that
    // trips the cap, which is why clients must paginate it.
    const full = JSON.parse(
      ((await h.client.callTool({ name: "adapter_list", arguments: { full: true } })) as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { truncated?: boolean; totalBytes?: number }
    expect(full.truncated).toBe(true)
    expect(full.totalBytes).toBeGreaterThan(100_000)
    await h.close()
  })

  it("compact projection defaults modelCount to 0 when the lister didn't populate models", async () => {
    const { models, ...withoutModels } = FULL_ADAPTER
    void models
    const h = await harness(async () => [withoutModels as AdapterListEntry])
    const result = await h.client.callTool({ name: "adapter_list", arguments: {} })
    const adapters = parseAdapters(result)
    expect(adapters).toEqual([
      { slug: "hermes", name: "Hermes", version: "1.2.3", protocol: "acp", installed: true, modelCount: 0 },
    ])
    await h.close()
  })

  it("full: true / compact: false return the old verbose payload (the pre-transformer default)", async () => {
    const h = await harness(async () => [FULL_ADAPTER])
    const result = await h.client.callTool({
      name: "adapter_list",
      arguments: { full: true },
    })
    // full:true → the complete, unprojected manifest entry.
    expect(parseAdapters(result)).toEqual([FULL_ADAPTER])
    await h.close()

    const h2 = await harness(async () => [FULL_ADAPTER])
    const result2 = await h2.client.callTool({
      name: "adapter_list",
      arguments: { compact: false },
    })
    expect(parseAdapters(result2)).toEqual([FULL_ADAPTER])
    await h2.close()
  })

  it("fields filters the compact rows on the paginated envelope branch", async () => {
    const h = await harness(async () => [FULL_ADAPTER])
    const raw = JSON.parse(
      (
        (await h.client.callTool({
          name: "adapter_list",
          arguments: { limit: 10, fields: ["slug", "version"] },
        })) as { content: Array<{ text: string }> }
      ).content[0]!.text,
    ) as { items: Array<Record<string, unknown>> }
    expect(raw.items).toEqual([{ slug: "hermes", version: "1.2.3" }])
    await h.close()
  })

  it("page-walk with limit=2 covers exactly the unpaginated list; full:true page-walk covers the verbose rows", async () => {
    const three: AdapterListEntry[] = [
      FULL_ADAPTER,
      { ...FULL_ADAPTER, slug: "claude-code", name: "Claude Code" },
      { ...FULL_ADAPTER, slug: "aider", name: "Aider" },
    ]
    const h = await harness(async () => three)

    // Default call: the { adapters } envelope, compact rows, no page fields.
    const unpaginated = parseAdapters(await h.client.callTool({ name: "adapter_list", arguments: {} }))
    expect(unpaginated).toEqual(
      three.map(a => ({
        slug: a.slug,
        name: a.name,
        version: a.version,
        protocol: a.protocol,
        installed: true,
        modelCount: a.models?.length ?? 0,
      })),
    )

    // Page-walk over the COMPACT rows: union == unpaginated.
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

    // Page-walk with full:true over the VERBOSE rows: union == full list.
    const fullUnion: AdapterListEntry[] = []
    let fullCursor: string | undefined
    do {
      const raw = JSON.parse(
        (
          (await h.client.callTool({
            name: "adapter_list",
            arguments: { full: true, limit: 2, ...(fullCursor ? { cursor: fullCursor } : {}) },
          })) as { content: Array<{ text: string }> }
        ).content[0]!.text,
      ) as { items: AdapterListEntry[]; nextCursor?: string }
      fullUnion.push(...raw.items)
      fullCursor = raw.nextCursor
    } while (fullCursor)
    expect(fullUnion).toEqual(three)

    await h.close()
  })
})
