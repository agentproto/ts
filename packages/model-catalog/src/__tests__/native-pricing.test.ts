/**
 * Generated rows priced from the vendor's own pricing page (priceSource
 * "anthropic" / "moonshot") bill at the vendor's rate end to end.
 */

import { describe, expect, it, vi } from "vitest"

// The generated vendor tables are rewritten by every catalog sync, so this
// suite replaces them with fixture rows shaped exactly like the generators'
// output. It asserts how a vendor-priced row is billed, not what a vendor
// currently charges for a given model.
vi.mock("../llm/moonshot-pricing.generated.js", () => ({
  MOONSHOT_GENERATED_PRICING: {
    "kimi-k3": { inputPer1M: 3, outputPer1M: 15, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1, priceSource: "moonshot", vendor: "moonshot", provider: "moonshot" },
  },
}))
vi.mock("../llm/anthropic-pricing.generated.js", () => ({
  ANTHROPIC_GENERATED_PRICING: {
    "claude-haiku-5-5": { inputPer1M: 0.1, outputPer1M: 0.5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, tiers: [{ aboveInputTokens: 100000, inputPer1M: 0.5, outputPer1M: 2.5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 }], priceSource: "anthropic", vendor: "anthropic", provider: "anthropic" },
  },
}))
vi.mock("../llm/minimax-pricing.generated.js", () => ({
  MINIMAX_GENERATED_PRICING: {
    "MiniMax-M3": { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadMultiplier: 0.2, tiers: [{ aboveInputTokens: 512000, inputPer1M: 0.6, outputPer1M: 2.4, cacheReadMultiplier: 0.2 }], priceSource: "minimax", vendor: "minimax", provider: "minimax" },
    "MiniMax-M2.7": { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadMultiplier: 0.2, cacheWriteMultiplier: 1.25, priceSource: "minimax", vendor: "minimax", provider: "minimax" },
    "MiniMax-M3.1-Flash": { inputPer1M: 0.15, outputPer1M: 0.6, cacheReadMultiplier: 0.1, priceSource: "minimax", vendor: "minimax", provider: "minimax" },
  },
}))

const { calculateLLMCreditCost, resolvePricing } = await import("../llm/catalog.js")

describe("first-party priced rows", () => {
  it("kimi-k3 bills at Moonshot's $3 / $15, cache hits at $0.30", () => {
    expect(resolvePricing("kimi-k3")).toMatchObject({ priceSource: "moonshot" })
    expect(calculateLLMCreditCost("kimi-k3", { inputTokens: 1_000_000, outputTokens: 100_000 }).productionCost).toBeCloseTo(3 + 1.5, 10)
    expect(
      calculateLLMCreditCost("kimi-k3", { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000 }).productionCost
    ).toBeCloseTo(0.3, 10)
  })

  it("claude-haiku-5-5 carries Anthropic's own >100k tier", () => {
    expect(resolvePricing("claude-haiku-5-5")).toMatchObject({ priceSource: "anthropic" })
    expect(calculateLLMCreditCost("claude-haiku-5-5", { inputTokens: 150_000, outputTokens: 10_000 }).productionCost).toBeCloseTo(
      0.15 * 0.5 + 0.01 * 2.5,
      10
    )
  })

  it("MiniMax-M3 bills at MiniMax's $0.30 / $1.20 and carries its >512k tier", () => {
    expect(resolvePricing("MiniMax-M3")).toMatchObject({
      priceSource: "minimax",
      inputPer1M: 0.3,
      outputPer1M: 1.2,
      tiers: [{ aboveInputTokens: 512000, inputPer1M: 0.6, outputPer1M: 2.4 }],
    })
    expect(calculateLLMCreditCost("MiniMax-M3", { inputTokens: 100_000, outputTokens: 100_000 }).productionCost).toBeCloseTo(
      0.1 * 0.3 + 0.1 * 1.2,
      10
    )
    expect(calculateLLMCreditCost("MiniMax-M3", { inputTokens: 600_000, outputTokens: 100_000 }).productionCost).toBeCloseTo(
      0.6 * 0.6 + 0.1 * 2.4,
      10
    )
  })

  it("MiniMax-M2.7 still resolves to MiniMax's own row ", () => {
    expect(resolvePricing("MiniMax-M2.7")).toMatchObject({
      priceSource: "minimax",
      inputPer1M: 0.3,
      outputPer1M: 1.2,
      cacheReadMultiplier: 0.2,
      cacheWriteMultiplier: 1.25,
    })
  })

  it("MiniMax-M3.1-Flash bills at MiniMax's $0.15 / $0.60, cache hits at $0.015", () => {
    expect(resolvePricing("MiniMax-M3.1-Flash")).toMatchObject({
      priceSource: "minimax",
      inputPer1M: 0.15,
      outputPer1M: 0.6,
      cacheReadMultiplier: 0.1,
    })
    expect(calculateLLMCreditCost("MiniMax-M3.1-Flash", { inputTokens: 1_000_000, outputTokens: 1_000_000 }).productionCost).toBeCloseTo(
      0.75,
      10
    )
  })
})
