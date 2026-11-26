import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { loadBillingManifest } from "../manifest/index.js"
import { createPricer } from "../spend/index.js"

const src = readFileSync(fileURLToPath(new URL("../__fixtures__/examples/usage-saas.BILLING.md", import.meta.url)), "utf8")
const load = (edit: (s: string) => string = s => s) => loadBillingManifest(edit(src), { strategies: [] })

describe("the usage section of BILLING.md", () => {
  it("is read into the handle and prices through the kit's pricer", () => {
    const m = load()
    expect(m.usage?.categories.map(c => c.id)).toEqual(["llm", "messaging-fee", "search"])
    const p = createPricer({ manifest: m, usage: m.usage as never })
    // 1 USD of cost, margin 1.5 (defaults), anchor 1 000 credits per USD, decimals 0.
    expect(p.price({ kind: "llm", key: "k", accountId: "a", providerCost: { amount: 1, currency: "USD" } }).minor).toBe(1_500)
    // at-cost ignores defaults.margin.
    expect(p.price({ kind: "messaging-fee", key: "k", accountId: "a", providerCost: { amount: 1, currency: "USD" } })).toMatchObject({ minor: 1_000, atCost: true })
  })
  it("a manifest without usage still loads", () => {
    expect(load(s => s.replace(/usage:\n(  .*\n|    .*\n)+/, "")).usage).toBeUndefined()
  })
  it("refuses duplicate category ids", () => {
    expect(() => load(s => s.replace("{ id: search,", "{ id: llm,"))).toThrow(/duplicate category 'llm'/)
  })
  it("refuses at-cost with a marginFloor above 1", () => {
    expect(() => load(s => s.replace("margin: at-cost }", "margin: at-cost, marginFloor: 1.5 }"))).toThrow(/at-cost cannot have a marginFloor/)
  })
  it("refuses a fixed cost in a currency the manifest has no rate for", () => {
    expect(() => load(s => s.replace("currency: USD } }", "currency: JPY } }"))).toThrow(/currency 'JPY'/)
  })
  it("normalises the currency of a fixed cost", () => {
    const m = load(s => s.replace("currency: USD } }", "currency: usd } }"))
    expect((m.usage?.categories[2]?.cost as { currency: string }).currency).toBe("USD")
  })
})
