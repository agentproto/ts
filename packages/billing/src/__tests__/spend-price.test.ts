import { describe, expect, it } from "vitest"
import { assertMarginFloors, createPricer, UnpricedUsageError, usageProblems, type UsageConfig, type UsageEvent } from "../spend/index.js"
import { loadBillingManifestForTest } from "./cases-kit.js"

// demo manifest: anchor USD at 100 credits, EUR at fx 1.18, credits have 2 decimals (1 credit = 100 minor).
const manifest = loadBillingManifestForTest("demo")
const ev = (over: Partial<UsageEvent> = {}): UsageEvent => ({ kind: "llm", key: "k1", accountId: "a", ...over })
const pricer = (usage: UsageConfig, extra: Partial<Parameters<typeof createPricer>[0]> = {}) => createPricer({ manifest, usage, ...extra })

describe("price: one rate, derived from the anchor", () => {
  it("1 USD of cost at margin 2 is 200 credits (20 000 minor)", () => {
    const p = pricer({ categories: [{ id: "llm", cost: { source: "measured" }, margin: 2 }] })
    expect(p.price(ev({ providerCost: { amount: 1, currency: "USD" } })).minor).toBe(20_000)
  })
  it("a euro cost converts by the manifest's fx, no second rate: 1 EUR at margin 1 is 118 credits", () => {
    const p = pricer({ categories: [{ id: "llm", cost: { source: "measured" }, margin: 1 }] })
    expect(p.price(ev({ providerCost: { amount: 1, currency: "EUR" } })).minor).toBe(11_800)
  })
  it("moving the one field (creditsPerUnit) moves every category", () => {
    const half = createPricer({
      manifest: (loadBillingManifestForTest as (n: string, e?: (s: string) => string) => typeof manifest)("demo", s => s.replace("creditsPerUnit: 100", "creditsPerUnit: 50")),
      usage: { categories: [{ id: "llm", cost: { source: "measured" }, margin: 2 }] },
    })
    expect(half.price(ev({ providerCost: { amount: 1, currency: "USD" } })).minor).toBe(10_000)
  })
  it("rounds a fraction of a minor unit up by default", () => {
    const p = pricer({ categories: [{ id: "llm", cost: { source: "measured" }, margin: 2 }] })
    // 0.000123 USD x 100 x 2 x 100 = 2.46 -> 3
    expect(p.price(ev({ providerCost: { amount: 0.000123, currency: "USD" } })).minor).toBe(3)
  })
  it("has no floor of its own: 0 unless the config sets one", () => {
    const p = pricer({ categories: [{ id: "llm", cost: { source: "measured" }, margin: 2 }] })
    expect(p.price(ev({ providerCost: { amount: 0, currency: "USD" } })).minor).toBe(0)
  })
  it("a configured per-action floor applies, from the category or from defaults", () => {
    const cost = { amount: 0.0000001, currency: "USD" }
    expect(pricer({ categories: [{ id: "llm", cost: { source: "measured" }, margin: 2, floorMinor: 5 }] }).price(ev({ providerCost: cost })).minor).toBe(5)
    expect(pricer({ defaults: { floorMinor: 1 }, categories: [{ id: "llm", cost: { source: "measured" }, margin: 2 }] }).price(ev({ providerCost: cost })).minor).toBe(1)
  })
  it("the kit has no margin of its own: 1 unless the config sets one", () => {
    expect(pricer({ categories: [{ id: "llm", cost: { source: "measured" } }] }).price(ev({ providerCost: { amount: 1, currency: "USD" } })).margin).toBe(1)
  })
  it("a fixed cost scales with units", () => {
    const p = pricer({ categories: [{ id: "search", match: { kind: "search" }, cost: { source: "fixed", amount: 0.0015, currency: "USD" }, margin: 2, floorMinor: 1 }] })
    expect(p.price(ev({ kind: "search", units: 10 })).minor).toBe(300) // 0.015 USD x 100 x 2 x 100
  })
})

describe("price: at-cost cannot be overridden", () => {
  const usage: UsageConfig = {
    defaults: { margin: 3 },
    categories: [
      { id: "fee", match: { kind: "messaging-fee" }, cost: { source: "measured" }, margin: "at-cost", floorMinor: 0 },
      { id: "llm", match: { kind: "llm" }, cost: { source: "measured" } },
    ],
  }
  const fee = { providerCost: { amount: 0.02, currency: "EUR" } }
  it("at-cost sells at 1.0 even when defaults say 3", () => {
    const r = pricer(usage).price(ev({ kind: "messaging-fee", ...fee }))
    expect(r.atCost).toBe(true)
    expect(r.margin).toBe(1)
    expect(r.minor).toBe(236) // 0.02 EUR x 118 credits x 100
    expect(r.realMargin).toBeCloseTo(1, 6)
  })
  it("a category without a margin takes the default", () => {
    expect(pricer(usage).price(ev({ providerCost: { amount: 1, currency: "USD" } })).minor).toBe(30_000)
  })
  it("at-cost is refused with a marginFloor above 1", () => {
    expect(usageProblems(manifest, { categories: [{ id: "x", cost: { source: "measured" }, margin: "at-cost", marginFloor: 1.1 }] })).toHaveLength(1)
  })
  it("at-cost passes the margin floor check at exactly 1", () => {
    expect(() => assertMarginFloors(pricer(usage), [ev({ kind: "messaging-fee", ...fee })])).not.toThrow()
  })
})

describe("price: an unpriced event fails closed", () => {
  it("no category matches", () => {
    const p = pricer({ categories: [{ id: "llm", match: { kind: "llm" }, cost: { source: "measured" } }] })
    expect(() => p.price(ev({ kind: "video", providerCost: { amount: 1, currency: "USD" } }))).toThrowError(UnpricedUsageError)
  })
  it("a measured category with no measured cost is an error, not zero", () => {
    const p = pricer({ categories: [{ id: "llm", cost: { source: "measured" } }] })
    try {
      p.price(ev())
      throw new Error("did not throw")
    } catch (e) {
      expect((e as UnpricedUsageError).reason).toBe("no-cost")
    }
  })
  it("a currency neither the anchor nor in fx is refused", () => {
    const p = pricer({ categories: [{ id: "llm", cost: { source: "measured" } }] })
    expect(() => p.price(ev({ providerCost: { amount: 1, currency: "JPY" } }))).toThrowError(/neither the anchor currency nor in fx/)
  })
  it("a catalog category with no price book, or a book without an answer, is an error", () => {
    expect(() => pricer({ categories: [{ id: "c", cost: { source: "catalog" } }] }).price(ev())).toThrowError(UnpricedUsageError)
    const p = pricer({ categories: [{ id: "c", cost: { source: "catalog" } }] }, { priceBook: { cost: () => null } })
    expect(() => p.price(ev())).toThrowError(UnpricedUsageError)
  })
  it("a catalog price book answers per event", () => {
    const p = pricer({ categories: [{ id: "c", cost: { source: "catalog" }, margin: 1 }] }, { priceBook: { cost: e => ({ amount: 0.01 * (e.units ?? 1), currency: "USD" }) } })
    expect(p.price(ev({ units: 3 })).minor).toBe(300)
  })
  it("negative or non-finite units are refused", () => {
    const p = pricer({ categories: [{ id: "c", cost: { source: "fixed", amount: 1, currency: "USD" } }] })
    expect(() => p.price(ev({ units: -1 }))).toThrowError(UnpricedUsageError)
    expect(() => p.price(ev({ units: Number.NaN }))).toThrowError(UnpricedUsageError)
  })
})

describe("price: category matching", () => {
  it("the most specific match wins", () => {
    const p = pricer({
      categories: [
        { id: "any", cost: { source: "fixed", amount: 1, currency: "USD" }, margin: 1 },
        { id: "llm", match: { kind: "llm" }, cost: { source: "fixed", amount: 2, currency: "USD" }, margin: 1 },
        { id: "llm-big", match: { kind: "llm", model: "big" }, cost: { source: "fixed", amount: 3, currency: "USD" }, margin: 1 },
      ],
    })
    expect(p.price(ev({ kind: "llm", model: "big" })).categoryId).toBe("llm-big")
    expect(p.price(ev({ kind: "llm", model: "small" })).categoryId).toBe("llm")
    expect(p.price(ev({ kind: "stt" })).categoryId).toBe("any")
  })
})

describe("price: config validation and margin floors", () => {
  it("rejects duplicates and an unknown currency", () => {
    const problems = usageProblems(manifest, {
      categories: [
        { id: "a", cost: { source: "measured" } },
        { id: "a", cost: { source: "measured" } },
        { id: "jpy", cost: { source: "fixed", amount: 1, currency: "JPY" } },
      ],
    })
    expect(problems.join("|")).toMatch(/duplicate category 'a'/)
    expect(problems.join("|")).toMatch(/currency 'JPY'/)
    expect(() => pricer({ categories: [{ id: "a", cost: { source: "measured" } }, { id: "a", cost: { source: "measured" } }] })).toThrowError(/invalid usage config/)
  })
  it("assertMarginFloors fails when a category sells under its floor", () => {
    const p = pricer({ categories: [{ id: "run", match: { kind: "run" }, cost: { source: "measured" }, margin: 1.05, marginFloor: 1.1 }] })
    expect(() => assertMarginFloors(p, [ev({ kind: "run", providerCost: { amount: 0.99, currency: "USD" } })])).toThrowError(/'run' sells at 1\.050 x cost, under its floor 1\.1/)
  })
  it("a margin of 1.5 on a metered category meets a 1.1 floor", () => {
    const p = pricer({ categories: [{ id: "img", match: { kind: "image" }, cost: { source: "measured" }, margin: 1.5, marginFloor: 1.1 }] })
    expect(() => assertMarginFloors(p, [ev({ kind: "image", providerCost: { amount: 0.167, currency: "USD" } })])).not.toThrow()
  })
})

describe("price: a bad cost never becomes a charge", () => {
  const p = pricer({ categories: [{ id: "llm", cost: { source: "measured" }, margin: 2 }] })
  it("refuses a NaN, infinite or negative provider cost", () => {
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      try {
        p.price(ev({ providerCost: { amount, currency: "USD" } }))
        throw new Error("did not throw")
      } catch (e) {
        expect((e as UnpricedUsageError).reason).toBe("invalid-cost")
      }
    }
  })
  it("refuses a negative fixed cost in the config", () => {
    expect(usageProblems(manifest, { categories: [{ id: "f", cost: { source: "fixed", amount: -1, currency: "USD" } }] })).toHaveLength(1)
  })
  it("a lowercase currency is normalised", () => {
    expect(p.price(ev({ providerCost: { amount: 1, currency: "usd" } })).minor).toBe(20_000)
  })
})
