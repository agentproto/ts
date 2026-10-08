/**
 * Generated rows priced from the vendor's own pricing page (priceSource
 * "anthropic" / "moonshot") bill at the vendor's rate end to end.
 */

import { describe, expect, it } from "vitest"
import { calculateLLMCreditCost, resolvePricing } from "../llm/catalog.js"

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

  it("MiniMax-M2.7 bills at MiniMax's $0.30 / $1.20 with its cache-write price", () => {
    expect(resolvePricing("MiniMax-M2.7")).toMatchObject({ priceSource: "minimax", cacheWriteMultiplier: 1.25 })
    expect(calculateLLMCreditCost("MiniMax-M2.7", { inputTokens: 1_000_000, outputTokens: 1_000_000 }).productionCost).toBeCloseTo(
      1.5,
      10
    )
  })
})
