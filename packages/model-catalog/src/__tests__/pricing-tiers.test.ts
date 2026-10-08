/**
 * Prompt-length pricing tiers — `LLMPricing.tiers` + `selectPricingTier`,
 * and every catalog cost path that must bill through them.
 *
 * Claude Haiku 5.5 (platform.claude.com/docs/en/about-claude/pricing,
 * checked 2026-10-08): prompts up to 100k tokens $0.10 in / $0.50 out
 * (cache hit $0.01), over 100k $0.50 / $2.50 (cache hit $0.05). The row is
 * mocked in exactly as `scripts/catalog-sync/sync-anthropic.mjs` emits it,
 * so these tests don't wait on the next catalog sync to land the model.
 */

import { describe, expect, it, vi } from "vitest"

vi.mock("../llm/anthropic-pricing.generated.js", async importOriginal => {
  const original = await importOriginal<typeof import("../llm/anthropic-pricing.generated.js")>()
  return {
    ANTHROPIC_GENERATED_PRICING: {
      ...original.ANTHROPIC_GENERATED_PRICING,
      "claude-haiku-5-5": { inputPer1M: 0.1, outputPer1M: 0.5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, tiers: [{ aboveInputTokens: 100000, inputPer1M: 0.5, outputPer1M: 2.5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 }], vendor: "anthropic", provider: "anthropic" },
    },
  }
})

const { calculateLLMCreditCost, getCacheStats, selectPricingTier } = await import("../llm/catalog.js")
const { calculateCost } = await import("../cost/index.js")

const HAIKU = "claude-haiku-5-5"

describe("selectPricingTier", () => {
  const base = {
    inputPer1M: 1,
    outputPer1M: 2,
    cacheReadMultiplier: 0.1,
    tiers: [
      { aboveInputTokens: 256_000, inputPer1M: 4, outputPer1M: 8 },
      { aboveInputTokens: 32_000, inputPer1M: 2, outputPer1M: 4, cacheReadMultiplier: 0.2 },
    ],
  }

  it("returns the pricing unchanged without tiers or within the base tier", () => {
    const flat = { inputPer1M: 1, outputPer1M: 2 }
    expect(selectPricingTier(flat, 10_000_000)).toBe(flat)
    expect(selectPricingTier(base, 32_000)).toBe(base)
  })

  it("picks the highest tier the prompt exceeds, regardless of array order", () => {
    expect(selectPricingTier(base, 32_001)).toMatchObject({ inputPer1M: 2, outputPer1M: 4, cacheReadMultiplier: 0.2 })
    expect(selectPricingTier(base, 300_000)).toMatchObject({ inputPer1M: 4, outputPer1M: 8 })
  })

  it("inherits the base cache multiplier when the tier doesn't carry one", () => {
    expect(selectPricingTier(base, 300_000).cacheReadMultiplier).toBe(0.1)
  })
})

describe("calculateLLMCreditCost — Claude Haiku 5.5 prompt-length tiers", () => {
  it("bills a short prompt at the ≤100k rates", () => {
    const r = calculateLLMCreditCost(HAIKU, { inputTokens: 50_000, outputTokens: 10_000 })
    // 0.05M × $0.10 + 0.01M × $0.50
    expect(r.productionCost).toBeCloseTo(0.01, 10)
    expect(r.pricing.inputPer1M).toBe(0.1)
    expect(r.isFallback).toBe(false)
  })

  it("bills a long prompt at the >100k rates — input AND output, 5x", () => {
    const r = calculateLLMCreditCost(HAIKU, { inputTokens: 150_000, outputTokens: 10_000 })
    // 0.15M × $0.50 + 0.01M × $2.50
    expect(r.productionCost).toBeCloseTo(0.1, 10)
    expect(r.pricing).toMatchObject({ inputPer1M: 0.5, outputPer1M: 2.5 })
  })

  it("keeps exactly 100k tokens in the base tier ('over 100,000')", () => {
    const r = calculateLLMCreditCost(HAIKU, { inputTokens: 100_000, outputTokens: 0 })
    expect(r.productionCost).toBeCloseTo(0.01, 10)
  })

  it("counts cached input toward the prompt length, and prices cache hits at the tier rate", () => {
    // 10k uncached + 95k cache-read = 105k prompt → over 100k.
    const r = calculateLLMCreditCost(HAIKU, {
      inputTokens: 10_000,
      outputTokens: 0,
      cacheReadInputTokens: 95_000,
    })
    // 0.01M × $0.50 + 0.095M × $0.05 (cache hit, >100k)
    expect(r.productionCost).toBeCloseTo(0.005 + 0.00475, 10)
  })

  it("flows through calculateCost and getCacheStats at the same tier", () => {
    const usage = { inputTokens: 150_000, outputTokens: 10_000 }
    expect(calculateCost(HAIKU, { kind: "llm", ...usage }).baseCostUsd).toBeCloseTo(0.1, 10)

    // 200k cache reads saved 0.9 × $0.50/1M of uncached input (tier rate).
    const stats = getCacheStats(HAIKU, { inputTokens: 1_000, outputTokens: 0, cacheReadInputTokens: 200_000 })
    expect(stats.providerCostSavedUsd).toBeCloseTo(0.2 * 0.5 * 0.9, 10)
  })
})

describe("calculateLLMCreditCost — generated native tiers (xAI, Google)", () => {
  it("grok-4.20: cache hits at xAI's cached rate, long prompts at the >200k rate", () => {
    // 100k cache-read tokens at $1.25 × 0.16 (were billed at the full $1.25).
    expect(
      calculateLLMCreditCost("grok-4.20", { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 100_000 }).productionCost
    ).toBeCloseTo(0.1 * 1.25 * 0.16, 10)
    // 300k prompt → $2.50 in / $5 out.
    expect(
      calculateLLMCreditCost("grok-4.20", { inputTokens: 300_000, outputTokens: 10_000 }).productionCost
    ).toBeCloseTo(0.3 * 2.5 + 0.01 * 5, 10)
  })

  it("gemini-2.5-pro: prompts over 200k bill at $2.50 / $15", () => {
    expect(
      calculateLLMCreditCost("gemini-2.5-pro", { inputTokens: 100_000, outputTokens: 10_000 }).productionCost
    ).toBeCloseTo(0.1 * 1.25 + 0.01 * 10, 10)
    expect(
      calculateLLMCreditCost("gemini-2.5-pro", { inputTokens: 300_000, outputTokens: 10_000 }).productionCost
    ).toBeCloseTo(0.3 * 2.5 + 0.01 * 15, 10)
  })
})
