import { describe, expect, it } from "vitest"
import { loadBillingManifest } from "../manifest/index.js"
import { createPricer, createShadow, usageReport, type ShadowEntry, type UsageConfig } from "../spend/index.js"
import { REFERENCE_MANIFEST } from "../testing/reference-manifest.js"

const manifest = loadBillingManifest(REFERENCE_MANIFEST)
const usage: UsageConfig = {
  categories: [
    { id: "llm", match: { kind: "llm" }, cost: { source: "measured" }, margin: 2, marginFloor: 1.5 },
    { id: "fee", match: { kind: "fee" }, cost: { source: "measured" }, margin: "at-cost" },
    { id: "cheap", match: { kind: "cheap" }, cost: { source: "measured" }, margin: 1, marginFloor: 1.2 },
  ],
}

async function run(events: unknown[]): Promise<ShadowEntry[]> {
  const out: ShadowEntry[] = []
  const s = createShadow({ pricer: createPricer({ manifest, usage }), sink: { write: e => void out.push(e) } })
  for (const e of events) await s.record(e as never)
  return out
}
const cost = (amount: number) => ({ amount, currency: "USD" })

describe("usageReport", () => {
  it("gives the real margin per category and the totals", async () => {
    const r = usageReport(await run([
      { kind: "llm", key: "1", accountId: "a", providerCost: cost(1) },
      { kind: "llm", key: "2", accountId: "a", providerCost: cost(3), units: 10 },
      { kind: "fee", key: "3", accountId: "a", providerCost: cost(2) },
    ]), usage)
    const llm = r.lines.find(l => l.categoryId === "llm")!
    expect(llm).toMatchObject({ events: 2, units: 11, chargedMinor: 80_000, costMinor: 40_000, realMargin: 2 })
    expect(r.lines.find(l => l.categoryId === "fee")).toMatchObject({ atCost: true, realMargin: 1 })
    expect(r.totalChargedMinor).toBe(100_000)
    expect(r.belowFloor).toEqual([])
  })
  it("counts a key once and keeps unpriced events apart", async () => {
    const e = { kind: "llm", key: "1", accountId: "a", providerCost: cost(1) }
    const r = usageReport(await run([e, e, { kind: "nothing", key: "2", accountId: "a" }, { kind: "llm", key: "3", accountId: "a" }]))
    expect(r.lines[0]).toMatchObject({ categoryId: "llm", events: 1 })
    expect(r.unpriced).toEqual({ events: 2, byReason: { "no-category": 1, "no-cost": 1 } })
  })
  it("names the categories that sell under their floor", async () => {
    const r = usageReport(await run([{ kind: "cheap", key: "1", accountId: "a", providerCost: cost(1) }]), usage)
    expect(r.belowFloor).toEqual([{ categoryId: "cheap", realMargin: 1, floor: 1.2 }])
  })
  it("splits by the opaque credentialSource tag, without interpreting it", async () => {
    const r = usageReport(await run([
      { kind: "llm", key: "1", accountId: "a", providerCost: cost(1), credentialSource: "customer" },
      { kind: "llm", key: "2", accountId: "a", providerCost: cost(1) },
    ]))
    expect(r.byCredentialSource).toEqual({ customer: { events: 1, chargedMinor: 20_000 }, "": { events: 1, chargedMinor: 20_000 } })
  })
})
