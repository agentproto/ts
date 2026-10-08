import { describe, expect, it } from "vitest"
import {
  deriveSessionUsage,
  plausibleContextUsed,
  projectSessionUsage,
  resolveSessionPricing,
  type PricingResolver,
} from "../usage.js"
import { resolvePricing } from "@agentproto/model-catalog/llm"
import { resolveLlmModelRoute } from "@agentproto/model-catalog/route-identity"

/**
 * The pricing decision tree is the heart of part ② — cover every source
 * branch (adapter / computed / no-pricing / none) with an injected catalog so
 * the assertions don't depend on the real catalog's contents.
 */

// Fake catalog: only "priced-model" has a price.
const fakeResolver: PricingResolver = model =>
  model === "priced-model" ? { inputPer1M: 3, outputPer1M: 15 } : undefined

describe("deriveSessionUsage", () => {
  it("source=adapter when the adapter reported a cost (wins over token pricing)", () => {
    const usage = deriveSessionUsage(
      {
        model: "priced-model",
        adapterCostUsd: 0.42,
        tokensIn: 1_000_000,
        tokensOut: 1_000_000,
        contextSize: 200_000,
        contextUsed: 12_345,
      },
      fakeResolver,
    )
    expect(usage.source).toBe("adapter")
    expect(usage.costUsd).toBe(0.42)
    // Tokens + context still surface alongside the adapter cost.
    expect(usage.tokensIn).toBe(1_000_000)
    expect(usage.contextUsed).toBe(12_345)
  })

  it("source=computed prices tokens × catalog rate when no adapter cost", () => {
    const usage = deriveSessionUsage(
      { model: "priced-model", tokensIn: 2_000_000, tokensOut: 500_000 },
      fakeResolver,
    )
    expect(usage.source).toBe("computed")
    // 2M×$3/1M + 0.5M×$15/1M = 6 + 7.5 = 13.5
    expect(usage.costUsd).toBeCloseTo(13.5, 10)
    expect(usage.tokensIn).toBe(2_000_000)
    expect(usage.tokensOut).toBe(500_000)
  })

  it("computed cost handles a one-sided token count (only output)", () => {
    const usage = deriveSessionUsage(
      { model: "priced-model", tokensOut: 1_000_000 },
      fakeResolver,
    )
    expect(usage.source).toBe("computed")
    expect(usage.costUsd).toBeCloseTo(15, 10)
  })

  it("source=no-pricing when tokens exist but the model isn't in the catalog — cost NEVER fabricated", () => {
    const usage = deriveSessionUsage(
      { model: "mystery-model", tokensIn: 1_000_000, tokensOut: 1_000_000 },
      fakeResolver,
    )
    expect(usage.source).toBe("no-pricing")
    expect(usage.costUsd).toBeUndefined()
    // Tokens are still surfaced — we just don't invent a price.
    expect(usage.tokensIn).toBe(1_000_000)
    expect(usage.tokensOut).toBe(1_000_000)
  })

  it("source=no-pricing when tokens exist but no model id is known", () => {
    const usage = deriveSessionUsage({ tokensIn: 500 }, fakeResolver)
    expect(usage.source).toBe("no-pricing")
    expect(usage.costUsd).toBeUndefined()
  })

  it("source=none when neither cost nor tokens are present", () => {
    const usage = deriveSessionUsage(
      { model: "priced-model", contextSize: 200_000, contextUsed: 10 },
      fakeResolver,
    )
    expect(usage.source).toBe("none")
    expect(usage.costUsd).toBeUndefined()
    expect(usage.contextUsed).toBe(10)
  })

  it("omits absent fields rather than emitting zeros", () => {
    const usage = deriveSessionUsage({ model: "priced-model" }, fakeResolver)
    expect(usage).toEqual({ model: "priced-model", source: "none" })
    expect("tokensIn" in usage).toBe(false)
    expect("costUsd" in usage).toBe(false)
  })

  it("never surfaces a stale out-of-window contextUsed at a session's exit-time recap (real bug shape)", () => {
    // A rejected ingress update leaves the descriptor's existing contextUsed
    // in place rather than clearing it — so a pre-guard or reloaded stale
    // value can still reach buildUsageSnapshot's call into this function.
    const usage = deriveSessionUsage(
      { model: "priced-model", contextSize: 200_000, contextUsed: 14_246_419 },
      fakeResolver,
    )
    expect(usage.contextSize).toBe(200_000)
    expect(usage.contextUsed).toBeUndefined()
  })

  it("still surfaces a plausible contextUsed (real plausible shape)", () => {
    const usage = deriveSessionUsage(
      { model: "priced-model", contextSize: 967_000, contextUsed: 202_718 },
      fakeResolver,
    )
    expect(usage.contextSize).toBe(967_000)
    expect(usage.contextUsed).toBe(202_718)
  })
})

describe("projectSessionUsage", () => {
  it("projects descriptor usage fields, defaulting an unstamped source to none", () => {
    expect(projectSessionUsage({ model: "m", costUsd: 1.5, tokensIn: 10 })).toEqual({
      model: "m",
      costUsd: 1.5,
      tokensIn: 10,
      source: "none",
    })
  })

  it("carries the stamped usageSource through", () => {
    const out = projectSessionUsage({
      model: "priced-model",
      costUsd: 13.5,
      tokensIn: 2_000_000,
      tokensOut: 500_000,
      contextSize: 200_000,
      contextUsed: 42,
      usageSource: "computed",
    })
    expect(out.source).toBe("computed")
    expect(out.contextUsed).toBe(42)
  })

  it("never surfaces a persisted, out-of-window contextUsed — the read-path gap (real bug shape, #364 follow-up)", () => {
    // Reproduces the live failure: sess_60a517cf persisted contextSize=
    // 200_000 / contextUsed=14_246_419 (71x over) from before
    // plausibleContextUsed existed. That session is dead — no future
    // usage_update will ever arrive to self-correct it — so the read path
    // itself, not just ingestion, has to refuse to surface it.
    const out = projectSessionUsage({
      model: "kimi-k2.7-code",
      costUsd: 8.955739,
      contextSize: 200_000,
      contextUsed: 14_246_419,
      usageSource: "adapter",
    })
    expect(out.contextSize).toBe(200_000)
    expect(out.contextUsed).toBeUndefined()
    expect("contextUsed" in out).toBe(false)
  })

  it("still projects a plausible contextUsed untouched (real plausible shape)", () => {
    const out = projectSessionUsage({
      model: "claude-sonnet-5",
      contextSize: 967_000,
      contextUsed: 202_718,
      usageSource: "computed",
    })
    expect(out.contextSize).toBe(967_000)
    expect(out.contextUsed).toBe(202_718)
  })
})

describe("plausibleContextUsed", () => {
  it("drops a cumulative-looking value that exceeds the reported window", () => {
    // The real bug: a hermes/kimi session's `used` was 14,246,419 against a
    // 200,000-token window — 71x over. That can't be "tokens in context."
    expect(plausibleContextUsed(200_000, 14_246_419)).toBeUndefined()
  })

  it("keeps a value that plausibly fits inside the window", () => {
    expect(plausibleContextUsed(967_000, 202_718)).toBe(202_718)
  })

  it("keeps a value exactly at the window boundary (100% occupancy is valid)", () => {
    expect(plausibleContextUsed(200_000, 200_000)).toBe(200_000)
  })

  it("passes the value through when the window size isn't known yet — nothing to disprove it with", () => {
    expect(plausibleContextUsed(undefined, 5_000)).toBe(5_000)
  })

  it("returns undefined when contextUsed itself is absent", () => {
    expect(plausibleContextUsed(200_000, undefined)).toBeUndefined()
  })
})

describe("usage detail fields (cache / reasoning / activity)", () => {
  const cachedResolver: PricingResolver = model =>
    model === "cached-model"
      ? { inputPer1M: 10, outputPer1M: 50, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 }
      : undefined

  it("prices cache tokens off the input rate with the catalog multipliers, disjoint from tokensIn", () => {
    const usage = deriveSessionUsage(
      {
        model: "cached-model",
        tokensIn: 1_000_000,
        tokensOut: 100_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 400_000,
      },
      cachedResolver,
    )
    expect(usage.source).toBe("computed")
    // in 1M×$10 + out 0.1M×$50 + read 2M×$1 + write 0.4M×$12.5 = 10+5+2+5
    expect(usage.costUsd).toBeCloseTo(22, 10)
    expect(usage.cacheReadTokens).toBe(2_000_000)
    expect(usage.cacheWriteTokens).toBe(400_000)
  })

  it("cache tokens alone are enough to compute a cost (multiplier defaults to 1)", () => {
    const usage = deriveSessionUsage({ model: "priced-model", cacheReadTokens: 1_000_000 }, fakeResolver)
    expect(usage.source).toBe("computed")
    expect(usage.costUsd).toBeCloseTo(3, 10)
  })

  it("never zero-fills absent detail fields; a measured 0 stays 0", () => {
    const usage = deriveSessionUsage(
      { model: "priced-model", tokensIn: 10, toolCalls: 0, turns: 2 },
      fakeResolver,
    )
    expect(usage.toolCalls).toBe(0)
    expect(usage.turns).toBe(2)
    for (const k of ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "durationMs"]) {
      expect(k in usage).toBe(false)
    }
  })

  it("projectSessionUsage surfaces turnsCompleted as `turns` and passes detail fields through", () => {
    const out = projectSessionUsage({
      costUsd: 1,
      cacheReadTokens: 500,
      reasoningTokens: 40,
      toolCalls: 3,
      durationMs: 1234,
      turnsCompleted: 2,
      usageSource: "adapter",
    })
    expect(out).toEqual({
      costUsd: 1,
      cacheReadTokens: 500,
      reasoningTokens: 40,
      turns: 2,
      toolCalls: 3,
      durationMs: 1234,
      source: "adapter",
    })
  })

  it("projectSessionUsage omits every detail field for a descriptor that has none", () => {
    const out = projectSessionUsage({ usageSource: "none" })
    expect(out).toEqual({ source: "none" })
  })
})

describe("deriveSessionUsage — prompt-length pricing tiers", () => {
  // Claude Haiku 5.5's shape: 5x over 100k prompt tokens.
  const tieredResolver: PricingResolver = () => ({
    inputPer1M: 0.1,
    outputPer1M: 0.5,
    cacheReadMultiplier: 0.1,
    tiers: [{ aboveInputTokens: 100_000, inputPer1M: 0.5, outputPer1M: 2.5 }],
  })
  const tokens = { model: "tiered", tokensIn: 1_000_000, tokensOut: 100_000, cacheReadTokens: 1_000_000 }

  it("prices at the base tier while the latest request's prompt is ≤100k", () => {
    const usage = deriveSessionUsage({ ...tokens, contextSize: 1_000_000, contextUsed: 80_000 }, tieredResolver)
    // 1M × $0.10 + 0.1M × $0.50 + 1M × $0.10 × 0.1
    expect(usage.costUsd).toBeCloseTo(0.1 + 0.05 + 0.01, 10)
  })

  it("prices at the >100k tier once the latest request's prompt is over it", () => {
    const usage = deriveSessionUsage({ ...tokens, contextSize: 1_000_000, contextUsed: 150_000 }, tieredResolver)
    // 1M × $0.50 + 0.1M × $2.50 + 1M × $0.50 × 0.1 (base cache ratio inherited)
    expect(usage.costUsd).toBeCloseTo(0.5 + 0.25 + 0.05, 10)
  })

  it("falls back to the base tier without a contextUsed signal", () => {
    const usage = deriveSessionUsage(tokens, tieredResolver)
    expect(usage.costUsd).toBeCloseTo(0.16, 10)
  })
})

/**
 * The DEFAULT resolver against the real catalog: a router-prefixed id must
 * price on its router's own row, never fall through `resolvePricing`'s
 * substring scan onto the direct vendor row.
 */
describe("resolveSessionPricing", () => {
  it("prices an OpenCode Go id on the opencode-go route, not direct Moonshot", () => {
    const pricing = resolveSessionPricing("opencode-go/kimi-k3")
    expect(pricing?.provider).toBe("opencode-go")
    expect(pricing).toEqual(resolveLlmModelRoute("opencode-go/kimi-k3")?.pricing)
    // The bug shape: the substring fallback lands on the direct Moonshot row.
    expect(resolvePricing("opencode-go/kimi-k3")?.provider).toBe("moonshot")
    // Not the direct row, whatever the two prices happen to be (they can
    // coincide after a catalog sync): the row's own provider differs.
    expect(pricing).not.toEqual(resolvePricing("kimi-k3"))
  })

  it("prices an OpenCode Zen id on the opencode route, not direct Anthropic", () => {
    expect(resolveSessionPricing("opencode/claude-sonnet-4-6")?.provider).toBe("opencode")
  })

  it("prices an explicit @router suffix on that router", () => {
    expect(resolveSessionPricing("openai/gpt-4.1@requesty")?.provider).toBe("requesty")
    expect(resolveSessionPricing("moonshotai/kimi-k3@openrouter")?.provider).toBe("openrouter")
  })

  it("leaves a router id with no row in its router's table unpriced instead of borrowing the vendor price", () => {
    expect(resolveSessionPricing("opencode-go/claude-sonnet-4-6")).toBeUndefined()
  })

  it("leaves bare ids and OpenRouter-native vendor/model ids on resolvePricing", () => {
    for (const id of ["kimi-k3", "claude-sonnet-4-6", "claude-sonnet-4-5[1m]", "moonshotai/kimi-k3", "anthropic/claude-sonnet-4.5"]) {
      expect(resolveSessionPricing(id)).toEqual(resolvePricing(id))
    }
    expect(resolveSessionPricing("kimi-k3")?.provider).toBe("moonshot")
  })

  it("is the default resolver deriveSessionUsage uses", () => {
    const usage = deriveSessionUsage({ model: "opencode-go/kimi-k3", tokensIn: 1_000_000 })
    expect(usage.source).toBe("computed")
    expect(usage.costUsd).toBeCloseTo(resolveLlmModelRoute("opencode-go/kimi-k3")!.pricing.inputPer1M, 10)
  })
})
