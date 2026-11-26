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
  const overlay = createOverlay({ manifest, usage, storage, clock, asset, policy: { dailyCapMinor: 50_000, perCallMaxMinor: 30_000, onShortfall: "refuse", ...policy } })
  return { clock, storage, overlay }
}

describe("example overlay: pure rules decide, the kit executes", () => {
  it("prices with the kit and debits with the kit", async () => {
    const s = await setup(100_000)
    expect(await s.overlay.charge(call("a", 1))).toMatchObject({ ok: true, charged: 20_000 })
    expect(await s.storage.spendableBalance("acct", asset)).toBe(80_000)
  })
  it("the daily cap is the layer's rule: over it the charge is refused, the result names the rule, nothing is written", async () => {
    const s = await setup(1_000_000)
    expect((await s.overlay.charge(call("a", 1))).ok).toBe(true) // 20 000
    expect((await s.overlay.charge(call("b", 1))).ok).toBe(true) // 40 000
    const r = await s.overlay.charge(call("c", 1)) // 60 000 > 50 000
    expect(r).toMatchObject({ ok: false, reason: "refused_by_rule", rule: "daily-cap" })
    expect(await s.storage.spendableBalance("acct", asset)).toBe(1_000_000 - 40_000)
  })
  it("the cap is a rolling day", async () => {
    const s = await setup(1_000_000)
    await s.overlay.charge(call("a", 1))
    await s.overlay.charge(call("b", 1))
    s.clock.advance(25 * 3_600_000)
    expect((await s.overlay.charge(call("c", 1))).ok).toBe(true)
  })
  it("a second rule lowers the amount and the trace shows both rules in order", async () => {
    const s = await setup(1_000_000)
    const r = await s.overlay.charge(call("a", 5)) // price 100 000, cap 50 000 -> refused first
    expect(r).toMatchObject({ ok: false, rule: "daily-cap" })
    const s2 = await setup(1_000_000, { dailyCapMinor: 1_000_000 })
    const r2 = await s2.overlay.charge(call("a", 5))
    expect(r2).toMatchObject({ ok: true, charged: 30_000, decidedBy: "per-call-max" })
    expect(r2.ok && r2.trace).toEqual([{ rule: "daily-cap", outcome: "pass" }, { rule: "per-call-max", outcome: "decided" }])
  })
  it("changing the policy changes the rule, not the kit", async () => {
    const s = await setup(1_000_000, { dailyCapMinor: 10_000 })
    expect(await s.overlay.charge(call("a", 1))).toMatchObject({ ok: false, rule: "daily-cap" })
  })
  it("the shortfall behaviour is the layer's choice", async () => {
    const refuse = await setup(5_000, { onShortfall: "refuse" })
    expect(await refuse.overlay.charge(call("a", 1))).toMatchObject({ ok: false, reason: "insufficient_funds" })
    const absorb = await setup(5_000, { onShortfall: "absorb" })
    expect(await absorb.overlay.charge(call("a", 1))).toMatchObject({ ok: true, charged: 5_000, shortfall: 15_000 })
  })
  it("an event the kit cannot price is not charged", async () => {
    const s = await setup(100_000)
    expect(await s.overlay.charge({ kind: "video", key: "v", accountId: "acct", providerCost: { amount: 1, currency: "USD" } })).toEqual({ ok: false, reason: "unpriced" })
  })
  it("a replayed key writes once, whatever the rules say the second time", async () => {
    const s = await setup(100_000)
    await s.overlay.charge(call("a", 1))
    expect(await s.overlay.charge(call("a", 1))).toMatchObject({ ok: true, replayed: true })
    expect(await s.storage.spendableBalance("acct", asset)).toBe(80_000)
  })
})
