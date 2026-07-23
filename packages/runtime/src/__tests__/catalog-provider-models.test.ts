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

  it("treats `route` as a synonym for `endpoint`, precedence to `route`", () => {
    const byRoute = buildCatalogProviderModels({ route: "anthropic" })
    const byEndpoint = buildCatalogProviderModels({ endpoint: "anthropic" })
    expect(byRoute.models.length).toBe(byEndpoint.models.length)
    // route wins when both are given.
    const both = buildCatalogProviderModels({ route: "anthropic", endpoint: "openai" })
    expect(both.provider).toBe("anthropic")
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
