import { describe, expect, it } from "vitest"

import { llmOpenRouterGenerator } from "../generators/llm-openrouter.js"
import { promptLengthTiers, serializeTiers } from "../sources/openrouter-prompt-tiers.mjs"
import type { GeneratorContext } from "../types.js"

// Live OpenRouter `pricing` shapes (2026-10-08). Haiku 5.5's override is its
// >100k-token tier — matches platform.claude.com/docs/en/about-claude/pricing.
const HAIKU_55_PRICING = {
  prompt: "0.0000001",
  completion: "0.0000005",
  input_cache_read: "0.00000001",
  input_cache_write: "0.000000125",
  overrides: [
    {
      min_prompt_tokens: 100000,
      prompt: "0.0000005",
      completion: "0.0000025",
      input_cache_read: "0.00000005",
      input_cache_write: "0.000000625",
      input_cache_write_1h: "0.000001",
    },
  ],
}

// Time-of-day discounts share `overrides` but are NOT prompt-length tiers.
const OFF_PEAK_PRICING = {
  prompt: "0.000000132",
  completion: "0.000000528",
  overrides: [
    { utc_start: 0, utc_end: 1600, prompt: "0.000000132", completion: "0.000000528" },
    { utc_days: ["saturday"], min_prompt_tokens: 1000, prompt: "0.0000001", completion: "0.0000004" },
  ],
}

describe("promptLengthTiers", () => {
  it("turns a min_prompt_tokens override into a tier with tier-relative cache ratios", () => {
    expect(promptLengthTiers(HAIKU_55_PRICING)).toEqual([
      { aboveInputTokens: 100000, inputPer1M: 0.5, outputPer1M: 2.5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
    ])
  })

  it("ignores time-of-day overrides, even ones that also carry min_prompt_tokens", () => {
    expect(promptLengthTiers(OFF_PEAK_PRICING)).toBeUndefined()
  })

  it("returns undefined without overrides and sorts multiple tiers ascending", () => {
    expect(promptLengthTiers({ prompt: "0.000001", completion: "0.000002" })).toBeUndefined()
    const tiers = promptLengthTiers({
      prompt: "0.00000078",
      completion: "0.0000078",
      overrides: [
        { min_prompt_tokens: 128000, prompt: "0.00000195", completion: "0.00000975" },
        { min_prompt_tokens: 32000, prompt: "0.00000156", completion: "0.0000078" },
      ],
    })
    expect(tiers?.map(t => t.aboveInputTokens)).toEqual([32000, 128000])
    // No cache fields on the override → none on the tier (the catalog inherits the base).
    expect(tiers?.[0]).toEqual({ aboveInputTokens: 32000, inputPer1M: 1.56, outputPer1M: 7.8 })
  })

  it("serializes as a TS object-literal field", () => {
    expect(serializeTiers(promptLengthTiers(HAIKU_55_PRICING)!)).toBe(
      "tiers: [{ aboveInputTokens: 100000, inputPer1M: 0.5, outputPer1M: 2.5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 }]"
    )
  })
})

describe("llm:openrouter generator — prompt-length tiers", () => {
  const ctx: GeneratorContext = {
    refresh: false,
    async fetchSource() {
      return {
        data: [
          { id: "anthropic/claude-haiku-5.5", pricing: HAIKU_55_PRICING },
          { id: "tencent/hy3", pricing: OFF_PEAK_PRICING },
        ],
      }
    },
  }

  it("emits tiers on a tiered route and none on a time-of-day route", async () => {
    const files = await llmOpenRouterGenerator.generate(ctx)
    const src = files["packages/model-catalog/src/llm/openrouter-routes.generated.ts"]!
    const haiku = src.slice(src.indexOf('"anthropic/claude-haiku-5.5"'), src.indexOf('"tencent/hy3"'))
    expect(haiku).toContain(
      "tiers: [{ aboveInputTokens: 100000, inputPer1M: 0.5, outputPer1M: 2.5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 }]"
    )
    expect(src.slice(src.indexOf('"tencent/hy3"'))).not.toContain("tiers:")
  })
})
