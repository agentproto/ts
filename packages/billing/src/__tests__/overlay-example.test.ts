import type { WalletEvent } from "@agentproto/wallet"
import { describe, expect, it } from "vitest"
import { InMemoryStorage, ManualClock } from "../testing/index.js"
import { createOverlay, type OverlayPolicy } from "./overlay-example.js"
import { loadBillingManifestForTest } from "./cases-kit.js"

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0)
const manifest = loadBillingManifestForTest("demo")
const asset = manifest.primaryAsset
const usage = { categories: [{ id: "llm", match: { kind: "llm" }, cost: { source: "measured" as const }, margin: 2 }] }
const call = (key: string, usd: number) => ({ kind: "llm", key, accountId: "acct", providerCost: { amount: usd, currency: "USD" } })

async function setup(balance: number, policy: Partial<OverlayPolicy> = {}) {
  const clock = new ManualClock(T0)
  const storage = new InMemoryStorage(clock)
  const mint: WalletEvent = { id: "m", accountId: "acct", kind: "mint", asset, partitionId: "main", restriction: [], amount: balance, lotId: "l", occurredAt: T0 }
  if (balance > 0) await storage.commit("acct", [mint])
  const overlay = createOverlay({ manifest, usage, storage, clock, asset, policy: { dailyCapMinor: 50_000, packBonusPercent: 10, onShortfall: "refuse", ...policy } })
  return { clock, storage, overlay }
}

describe("example overlay: the layer's rules sit on the kit's primitives", () => {
  it("prices with the kit and debits with the kit", async () => {
    const s = await setup(100_000)
    expect(await s.overlay.charge(call("a", 1))).toEqual({ ok: true, charged: 20_000, priceMinor: 20_000, replayed: false })
    expect(await s.storage.spendableBalance("acct", asset)).toBe(80_000)
  })
  it("the cap is the layer's rule: a charge over it is refused, nothing written", async () => {
    const s = await setup(1_000_000)
    expect((await s.overlay.charge(call("a", 1))).ok).toBe(true) // 20 000
    expect((await s.overlay.charge(call("b", 1))).ok).toBe(true) // 40 000
    expect(await s.overlay.charge(call("c", 1))).toEqual({ ok: false, reason: "capped" }) // 60 000 > 50 000
    expect(await s.storage.spendableBalance("acct", asset)).toBe(1_000_000 - 40_000)
  })
  it("the cap is a rolling day: the next day the account can spend again", async () => {
    const s = await setup(1_000_000)
    await s.overlay.charge(call("a", 1))
    await s.overlay.charge(call("b", 1))
    s.clock.advance(25 * 3_600_000)
    expect((await s.overlay.charge(call("c", 1))).ok).toBe(true)
  })
  it("changing the policy changes the rule, not the kit", async () => {
    const s = await setup(1_000_000, { dailyCapMinor: 10_000 })
    expect(await s.overlay.charge(call("a", 1))).toEqual({ ok: false, reason: "capped" })
  })
  it("the shortfall behaviour is the layer's choice", async () => {
    const refuse = await setup(5_000, { onShortfall: "refuse" })
    expect(await refuse.overlay.charge(call("a", 1))).toEqual({ ok: false, reason: "insufficient_funds" })
    const absorb = await setup(5_000, { onShortfall: "absorb" })
    expect(await absorb.overlay.charge(call("a", 1))).toMatchObject({ ok: true, charged: 5_000, priceMinor: 20_000 })
  })
  it("an event the kit cannot price is not charged", async () => {
    const s = await setup(100_000)
    expect(await s.overlay.charge({ kind: "video", key: "v", accountId: "acct", providerCost: { amount: 1, currency: "USD" } })).toEqual({ ok: false, reason: "unpriced" })
  })
  it("a replayed charge key writes once", async () => {
    const s = await setup(100_000)
    await s.overlay.charge(call("a", 1))
    expect(await s.overlay.charge(call("a", 1))).toMatchObject({ ok: true, replayed: true })
    expect(await s.storage.spendableBalance("acct", asset)).toBe(80_000)
  })
  it("the pack bonus is the layer's rule: a separate lot, once per pack", async () => {
    const s = await setup(0, { packBonusPercent: 30 })
    expect(await s.overlay.grantPackBonus("acct", "pack-1", 10_000)).toBe(3_000)
    expect(await s.overlay.grantPackBonus("acct", "pack-1", 10_000)).toBe(0)
    expect(await s.storage.spendableBalance("acct", asset)).toBe(3_000)
  })
})
