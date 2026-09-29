import { describe, expect, it } from "vitest"
import type { Bundle } from "@agentproto/runtime/bundles"
import type { AgentprotoConfig } from "@agentproto/runtime/config"
import type { ImportedMcpsConfig } from "@agentproto/runtime/mcp-imports"
import { mountDefault } from "../commands/mcp.js"

function harness(ids: string[], seed: { bundle?: Bundle; config?: AgentprotoConfig } = {}) {
  const imports: ImportedMcpsConfig = {
    version: 1,
    imports: ids.map(id => ({
      id,
      alias: id,
      addedAt: "2026-01-01T00:00:00.000Z",
      snapshot: { id, source: "claude-code", scope: "global", name: id, type: "http", url: "https://x.example" },
    })),
  }
  const state = { bundles: new Map<string, Bundle>(seed.bundle ? [[seed.bundle.id, seed.bundle]] : []), config: seed.config ?? {} }
  const deps = {
    loadImports: async () => imports,
    getBundle: async (id: string) => state.bundles.get(id),
    createBundle: async (b: Bundle) => void state.bundles.set(b.id, b),
    updateBundle: async (id: string, patch: Partial<Omit<Bundle, "id">>) =>
      void state.bundles.set(id, { ...state.bundles.get(id)!, ...patch, id }),
    loadConfig: async () => state.config,
    saveConfig: async (c: AgentprotoConfig) => void (state.config = c),
  }
  return { state, deps }
}

describe("agentproto mcp mount-default", () => {
  it("creates bundle harness-<adapter> and links it into defaults.adapters.<adapter>.bundles, keeping other config", async () => {
    const h = harness(["a", "b"], { config: { defaults: { skills: ["s"], adapters: { "claude-code": { skills: ["k"] } } } } })
    const r = await mountDefault("claude-code", ["a", "b"], h.deps)
    expect(r).toMatchObject({ bundleId: "harness-claude-code", bundle: "created", added: ["a", "b"], linked: true })
    expect(h.state.bundles.get("harness-claude-code")).toMatchObject({ mcpImports: ["a", "b"], skills: [] })
    expect(h.state.config.defaults).toEqual({
      skills: ["s"],
      adapters: { "claude-code": { skills: ["k"], bundles: ["harness-claude-code"] } },
    })
  })

  it("is idempotent and additive: a second run adds new ids only, never duplicates the link", async () => {
    const h = harness(["a", "b"])
    await mountDefault("hermes", ["a"], h.deps)
    const r2 = await mountDefault("hermes", ["a", "b"], h.deps)
    expect(r2).toMatchObject({ bundle: "updated", added: ["b"], linked: false })
    expect(h.state.bundles.get("harness-hermes")?.mcpImports).toEqual(["a", "b"])
    expect(h.state.config.defaults?.adapters?.hermes?.bundles).toEqual(["harness-hermes"])
    const r3 = await mountDefault("hermes", ["b"], h.deps)
    expect(r3).toMatchObject({ bundle: "unchanged", added: [], linked: false })
  })

  it("rejects unknown ids and bad adapter slugs without writing anything", async () => {
    const h = harness(["a"])
    await expect(mountDefault("claude-code", ["ghost"], h.deps)).rejects.toThrow(/unknown import id.*ghost.*a/)
    await expect(mountDefault("Bad Slug", ["a"], h.deps)).rejects.toThrow(/invalid adapter slug/)
    await expect(mountDefault("claude-code", [], h.deps)).rejects.toThrow(/at least one/)
    expect(h.state.bundles.size).toBe(0)
    expect(h.state.config).toEqual({})
  })

  it('leaves an existing "*" bundle untouched', async () => {
    const h = harness(["a"], { bundle: { id: "harness-x", label: "x", mcpImports: "*", skills: [] } })
    const r = await mountDefault("x", ["a"], h.deps)
    expect(r).toMatchObject({ bundle: "unchanged", mcpImports: "*", linked: true })
  })
})
