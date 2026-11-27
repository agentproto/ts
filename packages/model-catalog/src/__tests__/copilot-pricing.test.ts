import { describe, expect, it, vi } from "vitest"

// Fixture rows shaped like sync-copilot.mjs output, so the suite does not
// depend on which ids GitHub currently lists.
vi.mock("../llm/copilot-pricing.generated.js", () => {
  const row = (vendor: string, inputPer1M: number, outputPer1M: number, extra = {}) => ({
    inputPer1M, outputPer1M, cacheReadMultiplier: 0.1, priceSource: "github-copilot", vendor, ...extra,
  })
  return {
    COPILOT_GENERATED_PRICING: {
      "claude-sonnet-5.5": row("anthropic", 2, 10),
      "claude-haiku-5.5": row("anthropic", 0.1, 0.5),
      "claude-haiku-4.5": row("anthropic", 1, 5),
      "mai-code-1.1-flash": row("microsoft", 0.2, 1.2),
      "mai-code-2": row("microsoft", 0.5, 2.5, { promo: { until: "2027-05-17", then: { inputPer1M: 1, outputPer1M: 5 } } }),
      "mai-code-2-flash": row("microsoft", 0.05, 0.25),
    },
  }
})

const { LLM_PRICING_CATALOG, effectivePricing, resolvePricingExact } = await import("../llm/index.js")

describe("Copilot-priced ids", () => {
  it("MAI Code 2 and Flash have a price (they were n/a before)", () => {
    expect(resolvePricingExact("mai-code-2")).toBeDefined()
    expect(resolvePricingExact("mai-code-2-flash")).toBeDefined()
    expect(LLM_PRICING_CATALOG["mai-code-2"].priceSource).toBe("github-copilot")
  })

  it("the dotted Claude ids and MAI ids the copilot-cli harness lists resolve to a price", () => {
    for (const id of ["claude-sonnet-5.5", "claude-haiku-5.5", "claude-haiku-4.5", "mai-code-1.1-flash", "mai-code-2", "mai-code-2-flash"]) {
      expect(resolvePricingExact(id), id).toBeDefined()
    }
  })
})

describe("effectivePricing", () => {
  const row = {
    inputPer1M: 0.5,
    outputPer1M: 2.5,
    cacheReadMultiplier: 0.05,
    promo: { until: "2027-05-17", then: { inputPer1M: 1, outputPer1M: 5, cacheReadMultiplier: 0.05 } },
  }
  it("keeps the promo price while it runs", () => {
    expect(effectivePricing(row, new Date("2027-05-16T23:59:00Z"))).toBe(row)
  })
  it("switches to the standard price ON the until date", () => {
    const p = effectivePricing(row, new Date("2027-05-17T00:00:00Z"))
    expect(p).toMatchObject({ inputPer1M: 1, outputPer1M: 5, cacheReadMultiplier: 0.05 })
    expect(p.promo).toBeUndefined()
  })
  it("keeps a promo with no stated follow-up price", () => {
    const open = { inputPer1M: 0.75, outputPer1M: 3.75, promo: { until: "2026-12-31" } }
    expect(effectivePricing(open, new Date("2027-02-01T00:00:00Z"))).toBe(open)
  })
})
