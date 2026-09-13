/**
 * `buildCatalogProviderModels` (catalog-provider-models.ts) — the pure
 * per-provider enumeration behind the read-only `catalog_provider_models` MCP
 * tool (AIP-45 launch-menu "+" picker, phase 1). Backed straight by the
 * static catalog's `getModelsByProvider`, so these assertions ride real
 * catalog contents rather than an injected fixture. Every assertion fails on
 * `main`: the module and tool don't exist there.
 */

import { describe, it, expect } from "vitest"
import { buildCatalogProviderModels } from "../catalog-provider-models.js"

describe("buildCatalogProviderModels", () => {
  it("enumerates a direct vendor's full LLM list (anthropic)", () => {
    const res = buildCatalogProviderModels({ endpoint: "anthropic" })
    expect(res.provider).toBe("anthropic")
    expect(res.models.length).toBeGreaterThan(0)
    // Every anthropic entry is an LLM served on the anthropic route.
    expect(res.models.every(m => m.kind === "llm")).toBe(true)
    expect(res.models.every(m => m.route === "anthropic")).toBe(true)
    // A known current model is present, carrying token pricing + a label.
    const opus = res.models.find(m => m.id === "claude-opus-4-8")
    expect(opus).toBeDefined()
    expect(opus?.label).toBe("claude-opus-4-8")
    expect(opus?.pricing?.inPer1M).toBeGreaterThan(0)
    expect(opus?.pricing?.outPer1M).toBeGreaterThan(0)
  })

  it("returns the full widened OpenRouter surface (generated route map folded in)", () => {
    const res = buildCatalogProviderModels({ endpoint: "openrouter" })
    // The generated OPENROUTER_ROUTES table (hundreds of rows) is spread into
    // LLM_PRICING_CATALOG upstream, so the picker sees the whole surface here —
    // this is exactly the large list the tool doc warns not to log.
    expect(res.models.length).toBeGreaterThan(100)
    expect(res.models.every(m => m.route === "openrouter")).toBe(true)
  })

  it("surfaces addedAt (ISO date) for a sync-stamped OpenRouter route, null for a hand-maintained one", () => {
    const openrouter = buildCatalogProviderModels({ endpoint: "openrouter" })
    const glm = openrouter.models.find(m => m.id === "z-ai/glm-5.3-flash")
    expect(glm?.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const anthropic = buildCatalogProviderModels({ endpoint: "anthropic" })
    const opus = anthropic.models.find(m => m.id === "claude-opus-4-8")
    expect(opus?.addedAt).toBeNull()
  })

  it("treats `route` as a synonym for `endpoint`, precedence to `route`", () => {
    const byRoute = buildCatalogProviderModels({ route: "anthropic" })
    const byEndpoint = buildCatalogProviderModels({ endpoint: "anthropic" })
    expect(byRoute.models.length).toBe(byEndpoint.models.length)
    // route wins when both are given.
    const both = buildCatalogProviderModels({ route: "anthropic", endpoint: "openai" })
    expect(both.provider).toBe("anthropic")
  })

  it("enumerates Requesty's routed surface (REQUESTY_ROUTES, not LLM_PRICING_CATALOG)", () => {
    const res = buildCatalogProviderModels({ endpoint: "requesty" })
    expect(res.models.length).toBeGreaterThan(0)
    expect(res.models.every(m => m.kind === "llm")).toBe(true)
    expect(res.models.every(m => m.route === "requesty")).toBe(true)
    expect(res.models.every(m => m.id.endsWith("@requesty"))).toBe(true)
    const first = res.models[0]
    expect(first?.pricing?.inPer1M).toBeGreaterThan(0)
  })

  it("enumerates OpenCode Go's 36 models (OPENCODE_GO_ROUTES, not LLM_PRICING_CATALOG)", () => {
    const res = buildCatalogProviderModels({ endpoint: "opencode-go" })
    // The verified Go lineup. This is the enumeration the launch-menu picker
    // browses, and it is what makes an `opencode-go` auth profile's models
    // visible at all.
    expect(res.models).toHaveLength(36)
    expect(res.models.every(m => m.kind === "llm")).toBe(true)
    expect(res.models.every(m => m.route === "opencode-go")).toBe(true)
    // Ids are the bare `<provider>/<bare-id>` form a caller spawns — NOT a
    // `@opencode-go`-annotated one, because for this endpoint the route IS
    // the leading segment.
    expect(res.models.every(m => m.id.startsWith("opencode-go/"))).toBe(true)
    expect(res.models.every(m => !m.id.includes("@"))).toBe(true)
    const glm = res.models.find(m => m.id === "opencode-go/glm-5.3")
    expect(glm?.pricing?.inPer1M).toBe(1.4)
    expect(glm?.pricing?.outPer1M).toBe(4.4)
    expect(glm?.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("enumerates OpenCode Zen's 102 models, including the whole Claude family", () => {
    const res = buildCatalogProviderModels({ endpoint: "opencode" })
    expect(res.models).toHaveLength(102)
    expect(res.models.every(m => m.route === "opencode")).toBe(true)
    expect(res.models.every(m => m.id.startsWith("opencode/"))).toBe(true)
    const sonnet = res.models.find(m => m.id === "opencode/claude-sonnet-4-6")
    expect(sonnet?.pricing?.inPer1M).toBe(3)
    // `-free` variants are KEPT with a zero price — on this endpoint zero is
    // the truth, not a missing price, so they must not be filtered out.
    const free = res.models.find(m => m.id === "opencode/glm-5-free")
    expect(free?.pricing).toEqual({ inPer1M: 0, outPer1M: 0 })
  })

  it("keeps the two OpenCode endpoints disjoint (separate balances, separate lineups)", () => {
    const go = buildCatalogProviderModels({ endpoint: "opencode-go" }).models.map(m => m.id)
    const zen = buildCatalogProviderModels({ endpoint: "opencode" }).models.map(m => m.id)
    // Zen serves Claude; Go does not. Go serves omen-alpha; Zen does not.
    expect(zen).toContain("opencode/claude-opus-5")
    expect(go).not.toContain("opencode-go/claude-opus-5")
    expect(go).toContain("opencode-go/omen-alpha")
    // A prefix query must not bleed: `opencode` is not a prefix match for
    // `opencode-go` ids.
    expect(zen.some(id => id.startsWith("opencode-go/"))).toBe(false)
  })

  it("enumerates HuggingFace's routed surface uniformly with the other routers", () => {
    const res = buildCatalogProviderModels({ endpoint: "huggingface" })
    expect(res.models.length).toBeGreaterThan(0)
    expect(res.models.every(m => m.kind === "llm")).toBe(true)
    expect(res.models.every(m => m.route === "huggingface")).toBe(true)
    expect(res.models.every(m => m.id.endsWith("@huggingface"))).toBe(true)
  })

  it("does not duplicate OpenRouter ids when the router-table pass also serves them", () => {
    const res = buildCatalogProviderModels({ endpoint: "openrouter" })
    const ids = res.models.map(m => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("returns an empty list for an unknown provider — never throws", () => {
    const res = buildCatalogProviderModels({ endpoint: "no-such-provider-xyz" })
    expect(res).toEqual({ provider: "no-such-provider-xyz", models: [] })
  })

  it("returns an empty list for an empty/omitted provider", () => {
    expect(buildCatalogProviderModels({}).models).toEqual([])
    expect(buildCatalogProviderModels({ endpoint: "   " })).toEqual({ provider: "", models: [] })
    expect(buildCatalogProviderModels().models).toEqual([])
  })
})
