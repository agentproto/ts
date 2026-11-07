/**
 * Unit coverage for the canonical `harness_list` MCP tool and its strict
 * compatibility contract with `adapter_list`.
 *
 * #2313 renamed the discovery packages (`harness-<slug>` canonical,
 * `adapter-<slug>` legacy) but left the MCP surface on the old spelling.
 * `harness_list` is the canonical name; `adapter_list` must stay
 * byte-for-byte compatible for older clients (and old daemons keep
 * serving it). Both share ONE handler and ONE `paginated()` transformer
 * in agent-tools.ts, so these tests pin the equivalence rather than two
 * copies of the same assertions.
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AdapterListEntry, AdapterModelRow, AgentAdapterLister } from "../http-server.js"

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

function raw(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>
}

function rows(result: unknown): unknown[] {
  return raw(result).adapters as unknown[]
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

const FULL_ADAPTER: AdapterListEntry & { commands: unknown[] } = {
  slug: "hermes",
  name: "Hermes",
  version: "1.2.3",
  description: "A very long description that a picker never needs to render.",
  protocol: "acp",
  streaming: true,
  packageName: "@agentproto/harness-hermes",
  modes: [],
  models: ["z-ai/glm-5.2", "gpt-5"],
  commands: [{ id: "compact", description: "Compact context" }],
  modelDetails: [{ id: "z-ai/glm-5.2", provider: "openrouter" }] satisfies AdapterModelRow[],
}

const THREE: AdapterListEntry[] = [
  FULL_ADAPTER,
  { ...FULL_ADAPTER, slug: "claude-code", name: "Claude Code" },
  { ...FULL_ADAPTER, slug: "aider", name: "Aider" },
]

describe("harness_list", () => {
  it("reports 'not enabled' when no lister is wired", async () => {
    const h = await harness()
    const result = await h.client.callTool({ name: "harness_list", arguments: {} })
    expect(isError(result)).toBe(true)
    await h.close()
  })

  it("is equivalent to adapter_list: same compact rows, same { adapters } envelope", async () => {
    const h = await harness(async () => THREE)
    const canonical = await h.client.callTool({ name: "harness_list", arguments: {} })
    const legacy = await h.client.callTool({ name: "adapter_list", arguments: {} })
    expect(raw(canonical)).toEqual(raw(legacy))
    expect(raw(canonical)).toEqual({
      adapters: THREE.map(a => ({
        slug: a.slug,
        name: a.name,
        version: a.version,
        protocol: a.protocol,
        installed: true,
        modes: [],
        modelCount: 2,
      })),
    })
    await h.close()
  })

  it("is equivalent on the full / compact:false escape hatches", async () => {
    const h = await harness(async () => THREE)
    expect(raw(await h.client.callTool({ name: "harness_list", arguments: { full: true } })))
      .toEqual(raw(await h.client.callTool({ name: "adapter_list", arguments: { full: true } })))
    expect(raw(await h.client.callTool({ name: "harness_list", arguments: { compact: false } })))
      .toEqual(raw(await h.client.callTool({ name: "adapter_list", arguments: { compact: false } })))
    await h.close()
  })

  it("accepts both `harness` and the legacy `adapter` spelling for the ONE-slug filter", async () => {
    const h = await harness(async () => THREE)
    const byHarness = rows(await h.client.callTool({ name: "harness_list", arguments: { harness: "claude-code" } }))
    const byAdapter = rows(await h.client.callTool({ name: "harness_list", arguments: { adapter: "claude-code" } }))
    const bothSame = rows(
      await h.client.callTool({ name: "harness_list", arguments: { harness: "claude-code", adapter: "claude-code" } }),
    )
    expect(byHarness).toEqual(byAdapter)
    expect(bothSame).toEqual(byHarness)
    expect(byHarness).toHaveLength(1)
    await h.close()
  })

  it("rejects conflicting harness/adapter values with a clear validation error", async () => {
    const h = await harness(async () => THREE)
    const result = await h.client.callTool({
      name: "harness_list",
      arguments: { harness: "claude-code", adapter: "aider" },
    })
    expect(isError(result)).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toMatch(/harness_list/)
    expect(text).toMatch(/harness="claude-code"/)
    expect(text).toMatch(/adapter="aider"/)
    // No silent fallback: the conflicting call resolves no rows at all.
    expect(text).not.toMatch(/"adapters"/)
    await h.close()
  })

  it("filters honestly: an unknown slug is an empty list, not an error", async () => {
    const h = await harness(async () => THREE)
    expect(rows(await h.client.callTool({ name: "harness_list", arguments: { harness: "nope" } }))).toEqual([])
    await h.close()
  })

  it("shares fields/pagination: page-walk with limit=2 reproduces the unpaginated list", async () => {
    const h = await harness(async () => THREE)
    const unpaginated = rows(await h.client.callTool({ name: "harness_list", arguments: {} }))

    const union: Array<{ slug: string }> = []
    let cursor: string | undefined
    do {
      const page = raw(
        await h.client.callTool({
          name: "harness_list",
          arguments: { limit: 2, ...(cursor ? { cursor } : {}) },
        }),
      ) as { items: Array<{ slug: string }>; total: number; nextCursor?: string }
      expect(page.total).toBe(3)
      union.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)

    expect(union).toEqual(unpaginated)

    const fields = raw(
      await h.client.callTool({ name: "harness_list", arguments: { limit: 10, fields: ["slug", "version"] } }),
    ) as { items: Array<Record<string, unknown>> }
    expect(fields.items).toEqual([
      { slug: "hermes", version: "1.2.3" },
      { slug: "claude-code", version: "1.2.3" },
      { slug: "aider", version: "1.2.3" },
    ])
    await h.close()
  })

  it("matches adapter_list's budget/truncation behaviour (compact fits, full over-budget is marked)", async () => {
    const big: AdapterListEntry = {
      ...FULL_ADAPTER,
      models: Array.from({ length: 20_000 }, (_, i) => `vendor/model-${i}`),
    }
    const h = await harness(async () => [big, { ...big, slug: "claude-code" }])

    const compact = raw(await h.client.callTool({ name: "harness_list", arguments: {} }))
    expect(compact.truncated).toBeUndefined()
    expect((compact.adapters as unknown[]).length).toBe(2)
    expect((compact.adapters as Array<{ modelCount: number }>)[0]!.modelCount).toBe(20_000)

    const full = raw(await h.client.callTool({ name: "harness_list", arguments: { full: true } }))
    expect(full.truncated).toBe(true)
    expect(full.totalBytes as number).toBeGreaterThan(100_000)

    const legacyFull = raw(await h.client.callTool({ name: "adapter_list", arguments: { full: true } }))
    expect(full).toEqual(legacyFull)
    await h.close()
  })
})
