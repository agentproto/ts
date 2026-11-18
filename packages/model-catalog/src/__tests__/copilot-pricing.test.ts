import { describe, expect, it } from "vitest"
import { LLM_PRICING_CATALOG, effectivePricing, resolvePricingExact } from "../llm/index.js"

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
