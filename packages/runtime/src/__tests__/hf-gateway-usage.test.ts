import { describe, expect, it } from "vitest"
import { listRouterLlmRoutes } from "@agentproto/model-catalog/route-identity"
import { effectiveAdapterProvider } from "../model-wire.js"
import { deriveSessionUsage, pricingResolverFor } from "../usage.js"

describe("hermes on the huggingface gateway", () => {
  it("names the gateway, not the manifest provider, as adapterProvider", () => {
    expect(effectiveAdapterProvider("hermes", "openrouter", "huggingface")).toBe("huggingface")
    expect(effectiveAdapterProvider("hermes", "openrouter", undefined)).toBe("openrouter")
    expect(effectiveAdapterProvider("codex", "openai", "huggingface")).toBe("openai")
  })

  it("prices from the HF route table (cheapest live provider), per 1M tokens", () => {
    // Prices and the set of models are regenerated weekly (Catalog Sync), so
    // neither the id nor the expected cost is pinned: take any HF route that
    // carries a price and expect its own table price for 1M in + 1M out.
    const route = listRouterLlmRoutes("huggingface").find(
      r => r.pricing && r.pricing.inputPer1M > 0 && r.pricing.outputPer1M > 0,
    )
    expect(route, "the HF route table has at least one priced model").toBeDefined()
    const { vendor, product } = route!.ref
    const model = `${vendor}/${product}`
    const u = deriveSessionUsage(
      { model, tokensIn: 1_000_000, tokensOut: 1_000_000 },
      pricingResolverFor("huggingface"),
    )
    expect(u.source).toBe("computed")
    expect(u.costUsd).toBeCloseTo(
      route!.pricing!.inputPer1M + route!.pricing!.outputPer1M,
      6,
    )
    expect(u.model).toBe(model)
  })

  it("reports an HF model whose providers publish no price as unpriced, not DEFAULT_PRICING", () => {
    const u = deriveSessionUsage(
      { model: "CohereLabs/aya-expanse-32b", tokensIn: 1_000_000, tokensOut: 1_000_000 },
      pricingResolverFor("huggingface"),
    )
    expect(u.source).toBe("no-pricing")
    expect(u.costUsd).toBeUndefined()
  })

  it("prices the real session (Qwen/Qwen3.8-27B) at the cheapest live provider, not $4494", () => {
    const u = deriveSessionUsage(
      { model: "Qwen/Qwen3.8-27B", tokensIn: 18163, tokensOut: 206 },
      pricingResolverFor("huggingface"),
    )
    expect(u.source).toBe("computed")
    expect(u.costUsd).toBeLessThan(0.1)
  })

  it("reports an HF model absent from the table as unpriced, never a number", () => {
    const u = deriveSessionUsage(
      { model: "Qwen/NotInTable-1B", tokensIn: 18163, tokensOut: 206 },
      pricingResolverFor("huggingface"),
    )
    expect(u.source).toBe("no-pricing")
    expect(u.costUsd).toBeUndefined()
  })
})
