import { describe, expect, it } from "vitest"

import { xaiPricingRow } from "../sources/xai-pricing.mjs"

// Real row from snapshots/llm-xai.json (xAI /v1/models, native prices in
// 1/10000 $ per 1M tokens).
const GROK_4_20 = {
  id: "grok-4.20-0309-reasoning",
  context_length: 1000000,
  prompt_text_token_price: 12500,
  cached_prompt_text_token_price: 2000,
  completion_text_token_price: 25000,
  prompt_text_token_price_long_context: 25000,
  cached_prompt_text_token_price_long_context: 4000,
  completion_text_token_price_long_context: 50000,
  long_context_threshold: 200000,
}

describe("xaiPricingRow", () => {
  it("emits the cached price as cacheReadMultiplier and the long-context price as a tier", () => {
    expect(xaiPricingRow(GROK_4_20)).toEqual({
      id: "grok-4.20-0309-reasoning",
      inputPer1M: 1.25,
      outputPer1M: 2.5,
      cacheReadMultiplier: 0.16,
      tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }],
    })
  })

  it("omits the tier and cache ratio when xAI doesn't publish them", () => {
    expect(
      xaiPricingRow({ id: "grok-x", context_length: 131072, prompt_text_token_price: 2000, completion_text_token_price: 5000 })
    ).toEqual({ id: "grok-x", inputPer1M: 0.2, outputPer1M: 0.5 })
  })

  it("skips non-text models (no token prices)", () => {
    expect(xaiPricingRow({ id: "grok-imagine-image", context_length: 16000, image_price: 200000000 })).toBeUndefined()
  })
})
