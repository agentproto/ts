import { describe, expect, it } from "vitest"
import { hermesRowUsage } from "../index.js"

describe("hermesRowUsage", () => {
  it("maps the state.db sessions row, including the cache + reasoning split", () => {
    expect(
      hermesRowUsage({
        estimated_cost_usd: 0.12,
        input_tokens: 900,
        output_tokens: 80,
        cache_read_tokens: 5_000,
        cache_write_tokens: 600,
        reasoning_tokens: 30,
      }),
    ).toEqual({
      costUsd: 0.12,
      tokensIn: 900,
      tokensOut: 80,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 600,
      reasoningTokens: 30,
    })
  })

  it("drops NULL and missing columns (older schema, cost not written yet) instead of zero-filling", () => {
    expect(hermesRowUsage({ estimated_cost_usd: null, input_tokens: 10, output_tokens: 2 })).toEqual({
      tokensIn: 10,
      tokensOut: 2,
    })
  })
})
