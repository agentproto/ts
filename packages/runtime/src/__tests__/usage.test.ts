import { describe, expect, it } from "vitest"
import {
  deriveSessionUsage,
  plausibleContextUsed,
  projectSessionUsage,
  type PricingResolver,
} from "../usage.js"

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
