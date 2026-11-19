import { describe, expect, it } from "vitest"
import { effectiveAdapterProvider } from "../model-wire.js"
import { deriveSessionUsage, pricingResolverFor } from "../usage.js"

describe("hermes on the huggingface gateway", () => {
  it("names the gateway, not the manifest provider, as adapterProvider", () => {
    expect(effectiveAdapterProvider("hermes", "openrouter", "huggingface")).toBe("huggingface")
    expect(effectiveAdapterProvider("hermes", "openrouter", undefined)).toBe("openrouter")
    expect(effectiveAdapterProvider("codex", "openai", "huggingface")).toBe("openai")
  })

  it("prices from the HF route table (cheapest live provider), per 1M tokens", () => {
    const u = deriveSessionUsage(
      { model: "Qwen/Qwen3-14B", tokensIn: 1_000_000, tokensOut: 1_000_000 },
      pricingResolverFor("huggingface"),
    )
    expect(u.source).toBe("computed")
    expect(u.costUsd).toBeCloseTo(0.36, 6)
    expect(u.model).toBe("Qwen/Qwen3-14B")
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
