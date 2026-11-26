import type { WalletEvent } from "@agentproto/wallet"
import { describe, expect, it } from "vitest"
import { createPricer, createShadow, type ShadowEntry, type UsageEvent } from "../spend/index.js"
import { InMemoryStorage, ManualClock } from "../testing/index.js"
import { loadBillingManifestForTest } from "./cases-kit.js"

const manifest = loadBillingManifestForTest("demo")
const pricer = createPricer({ manifest, usage: { categories: [{ id: "llm", match: { kind: "llm" }, cost: { source: "measured" }, margin: 2 }] } })
const ev = (over: Partial<UsageEvent> = {}): UsageEvent => ({ kind: "llm", key: "k1", accountId: "a", providerCost: { amount: 1, currency: "USD" }, ...over })

describe("shadow: price and record, never debit", () => {
  it("writes the priced entry to the sink and leaves the journal untouched", async () => {
    const clock = new ManualClock(Date.UTC(2026, 10, 20))
    const storage = new InMemoryStorage(clock)
    const mint: WalletEvent = { id: "m", accountId: "a", kind: "mint", asset: manifest.primaryAsset, partitionId: "p", restriction: [], amount: 1_000, lotId: "l", occurredAt: clock.nowMs() }
    await storage.commit("a", [mint])
    const got: ShadowEntry[] = []
    const shadow = createShadow({ pricer, sink: { write: e => void got.push(e) } })
    const r = await shadow.record(ev())
    expect(r).toMatchObject({ status: "priced", price: { minor: 20_000, categoryId: "llm" } })
    expect(got).toHaveLength(1)
    expect(await storage.loadEvents("a")).toEqual([mint])
    expect(await storage.spendableBalance("a", manifest.primaryAsset)).toBe(1_000)
  })
  it("an unpriced event is recorded as unpriced and alerts, it does not throw and is never free", async () => {
    const got: ShadowEntry[] = []
    const alerts: string[] = []
    const shadow = createShadow({ pricer, sink: { write: e => void got.push(e) }, alert: e => void alerts.push(e.reason) })
    const r = await shadow.record(ev({ kind: "video" }))
    expect(r).toMatchObject({ status: "unpriced", reason: "no-category" })
    expect(got).toHaveLength(1)
    expect(alerts).toEqual(["no-category"])
  })
  it("a measured category with no measured cost is recorded as unpriced (no-cost)", async () => {
    const shadow = createShadow({ pricer, sink: { write: () => {} } })
    expect(await shadow.record(ev({ providerCost: undefined }))).toMatchObject({ status: "unpriced", reason: "no-cost" })
  })
  it("refuses to start without a pricer or a sink: a missing engine is an error, not a zero", () => {
    expect(() => createShadow({ sink: { write: () => {} } } as never)).toThrowError(/pricer is required/)
    expect(() => createShadow({ pricer } as never)).toThrowError(/sink is required/)
  })
})

describe("shadow: a failing alert never loses the record", () => {
  it("writes the unpriced entry first and survives an alert that throws or rejects", async () => {
    for (const alert of [() => { throw new Error("slack down") }, () => Promise.reject(new Error("slack down"))]) {
      const got: ShadowEntry[] = []
      const shadow = createShadow({ pricer, sink: { write: e => void got.push(e) }, alert })
      expect(await shadow.record(ev({ kind: "video" }))).toMatchObject({ status: "unpriced" })
      expect(got).toHaveLength(1)
    }
  })
  it("a NaN cost is recorded as unpriced, not as priced", async () => {
    const got: ShadowEntry[] = []
    const shadow = createShadow({ pricer, sink: { write: e => void got.push(e) } })
    expect(await shadow.record(ev({ providerCost: { amount: Number.NaN, currency: "USD" } }))).toMatchObject({ status: "unpriced", reason: "invalid-cost" })
  })
})

describe("credentialSource: an opaque tag, passed through and never interpreted", () => {
  it("is copied to the price result and the shadow entry, whatever its value, and does not change the price", async () => {
    const got: ShadowEntry[] = []
    const shadow = createShadow({ pricer, sink: { write: e => void got.push(e) } })
    const plain = await shadow.record(ev())
    for (const tag of ["customer", "platform", "anything-at-all", ""]) {
      const r = await shadow.record(ev({ credentialSource: tag }))
      expect(r).toMatchObject({ status: "priced", event: { credentialSource: tag }, price: { credentialSource: tag } })
      expect(r.status === "priced" && plain.status === "priced" && r.price.minor === plain.price.minor).toBe(true)
    }
    expect(plain.status === "priced" && "credentialSource" in plain.price).toBe(false)
  })
})
