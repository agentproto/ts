import type { WalletEvent } from "@agentproto/wallet"
import { describe, expect, it } from "vitest"
import { createHolds } from "../spend/index.js"
import { InMemoryStorage, ManualClock } from "../testing/index.js"

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0)
const ASSET = "credits"

async function setup(balance = 1_000) {
  const clock = new ManualClock(T0)
  const storage = new InMemoryStorage(clock)
  const mint = (lot: string, amount: number, extra: Partial<WalletEvent> = {}): WalletEvent => ({
    id: `mint:${lot}`, accountId: "acct", kind: "mint", asset: ASSET, partitionId: "main", restriction: [], amount, lotId: lot, occurredAt: T0, ...extra,
  })
  if (balance > 0) await storage.commit("acct", [mint("lot1", balance)])
  const holds = createHolds({ storage, clock }, { asset: ASSET })
  return { clock, storage, holds, mint }
}
const spendable = (s: { storage: InMemoryStorage }) => s.storage.spendableBalance("acct", ASSET)

describe("holds: reserve before the call", () => {
  it("reserves before the action and lowers the spendable balance", async () => {
    const s = await setup(1_000)
    const r = await s.holds.hold({ accountId: "acct", key: "call-1", amount: 400 })
    expect(r.ok && r.hold.reserved).toBe(400)
    expect(await spendable(s)).toBe(600)
  })
  it("refuses when the balance does not cover the amount, and writes nothing", async () => {
    const s = await setup(300)
    const r = await s.holds.hold({ accountId: "acct", key: "call-1", amount: 400 })
    expect(r).toEqual({ ok: false, reason: "insufficient_funds" })
    expect(await spendable(s)).toBe(300)
    expect((await s.storage.loadEvents("acct")).filter(e => e.kind === "reserve")).toHaveLength(0)
  })
  it("refuses an empty account and a non-positive amount", async () => {
    const s = await setup(0)
    expect((await s.holds.hold({ accountId: "acct", key: "k", amount: 10 })).ok).toBe(false)
    expect(await s.holds.hold({ accountId: "acct", key: "k", amount: 0 })).toEqual({ ok: false, reason: "invalid_amount" })
  })
  it("holds what the account has when it covers minToStart", async () => {
    const s = await setup(300)
    const holds = createHolds({ storage: s.storage, clock: s.clock }, { asset: ASSET, minToStart: 100 })
    const r = await holds.hold({ accountId: "acct", key: "c", amount: 400 })
    expect(r.ok && r.hold.reserved).toBe(300)
    const poor = await setup(50)
    const h2 = createHolds({ storage: poor.storage, clock: poor.clock }, { asset: ASSET, minToStart: 100 })
    expect((await h2.hold({ accountId: "acct", key: "c", amount: 400 })).ok).toBe(false)
  })
  it("a second hold on the same key writes nothing (replay)", async () => {
    const s = await setup(1_000)
    await s.holds.hold({ accountId: "acct", key: "call-1", amount: 400 })
    const again = await s.holds.hold({ accountId: "acct", key: "call-1", amount: 400 })
    expect(again.ok && again.replayed).toBe(true)
    expect(await spendable(s)).toBe(600)
  })
  it("refuses a key already used for another asset instead of replaying it", async () => {
    const s = await setup(1_000)
    await s.holds.hold({ accountId: "acct", key: "k", amount: 100 })
    const other = createHolds({ storage: s.storage, clock: s.clock }, { asset: "other" })
    expect(await other.hold({ accountId: "acct", key: "k", amount: 100 })).toEqual({ ok: false, reason: "key_conflict" })
  })
  it("two concurrent holds cannot both take the same money", async () => {
    const s = await setup(500)
    const [a, b] = await Promise.all([
      s.holds.hold({ accountId: "acct", key: "a", amount: 400 }),
      s.holds.hold({ accountId: "acct", key: "b", amount: 400 }),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
  })
  it("draws expiring lots first and spreads across lots", async () => {
    const s = await setup(0)
    await s.storage.commit("acct", [s.mint("late", 300), s.mint("soon", 200, { expiresAt: T0 + 1_000 })])
    const r = await s.holds.hold({ accountId: "acct", key: "c", amount: 350 })
    expect(r.ok && r.hold.draws.map(d => [d.lotId, d.amount])).toEqual([["soon", 200], ["late", 150]])
  })
})

describe("holds: settle at the real cost, capped to the reserve", () => {
  it("captures the actual cost and gives the rest back", async () => {
    const s = await setup(1_000)
    const r = await s.holds.hold({ accountId: "acct", key: "c", amount: 400 })
    if (!r.ok) throw new Error("hold")
    expect(await s.holds.settle(r.hold, 150)).toMatchObject({ charged: 150, released: 250, overrun: 0 })
    expect(await spendable(s)).toBe(850)
  })
  it("never captures more than the reserve; the excess is reported", async () => {
    const s = await setup(1_000)
    const r = await s.holds.hold({ accountId: "acct", key: "c", amount: 400 })
    if (!r.ok) throw new Error("hold")
    expect(await s.holds.settle(r.hold, 900)).toMatchObject({ charged: 400, released: 0, overrun: 500 })
    expect(await spendable(s)).toBe(600)
  })
  it("settling twice charges once", async () => {
    const s = await setup(1_000)
    const r = await s.holds.hold({ accountId: "acct", key: "c", amount: 400 })
    if (!r.ok) throw new Error("hold")
    await s.holds.settle(r.hold, 100)
    const again = await s.holds.settle(r.hold, 100)
    expect(again).toMatchObject({ charged: 100, replayed: true })
    expect(await spendable(s)).toBe(900)
  })
  it("settles across several lots", async () => {
    const s = await setup(0)
    await s.storage.commit("acct", [s.mint("soon", 200, { expiresAt: T0 + 1_000 }), s.mint("late", 300)])
    const r = await s.holds.hold({ accountId: "acct", key: "c", amount: 350 })
    if (!r.ok) throw new Error("hold")
    expect(await s.holds.settle(r.hold, 250)).toMatchObject({ charged: 250, released: 100 })
    expect(await spendable(s)).toBe(250)
  })
})

describe("holds: release on failure or crash", () => {
  it("release gives everything back", async () => {
    const s = await setup(1_000)
    const r = await s.holds.hold({ accountId: "acct", key: "c", amount: 400 })
    if (!r.ok) throw new Error("hold")
    expect(await s.holds.release(r.hold)).toMatchObject({ charged: 0, released: 400 })
    expect(await spendable(s)).toBe(1_000)
  })
  it("sweep frees an orphan hold after a crash, and only old ones", async () => {
    const s = await setup(1_000)
    await s.holds.hold({ accountId: "acct", key: "old", amount: 300 })
    s.clock.advance(60 * 60_000)
    await s.holds.hold({ accountId: "acct", key: "fresh", amount: 200 })
    expect(await spendable(s)).toBe(500)
    expect(await s.holds.sweep("acct", { olderThanMs: 30 * 60_000 })).toEqual(["old"])
    expect(await spendable(s)).toBe(800)
    expect(await s.holds.sweep("acct", { olderThanMs: 30 * 60_000 })).toEqual([])
  })
  it("sweep does not report a hold its owner settled in the meantime", async () => {
    const s = await setup(1_000)
    const r = await s.holds.hold({ accountId: "acct", key: "c", amount: 400 })
    if (!r.ok) throw new Error("hold")
    s.clock.advance(3_600_000)
    // The owner settles after the sweep read the journal and before it closes the hold.
    const realLoad = s.storage.loadEvents.bind(s.storage)
    let first = true
    s.storage.loadEvents = async (id: string) => {
      const ev = await realLoad(id)
      if (first) {
        first = false
        queueMicrotask(() => void s.holds.settle(r.hold, 100))
      }
      return ev
    }
    const swept = await s.holds.sweep("acct", { olderThanMs: 1 })
    await new Promise(res => setTimeout(res, 5))
    expect(swept).toEqual([])
    expect(await spendable(s)).toBe(900)
  })
  it("sweep never touches a settled hold", async () => {
    const s = await setup(1_000)
    const r = await s.holds.hold({ accountId: "acct", key: "c", amount: 400 })
    if (!r.ok) throw new Error("hold")
    await s.holds.settle(r.hold, 400)
    s.clock.advance(3_600_000)
    expect(await s.holds.sweep("acct", { olderThanMs: 1 })).toEqual([])
    expect(await spendable(s)).toBe(600)
  })
})

describe("checkpoint", () => {
  it("continues, warns at 80 %, cuts off at 95 %", async () => {
    const s = await setup(1_000)
    const r = await s.holds.hold({ accountId: "acct", key: "c", amount: 1_000 })
    if (!r.ok) throw new Error("hold")
    expect(s.holds.checkpoint(r.hold, 500).action).toBe("continue")
    expect(s.holds.checkpoint(r.hold, 800).action).toBe("warn")
    expect(s.holds.checkpoint(r.hold, 950).action).toBe("cutoff")
  })
  it("thresholds are options", async () => {
    const s = await setup(1_000)
    const holds = createHolds({ storage: s.storage, clock: s.clock }, { asset: ASSET, warnAt: 0.5, cutoffAt: 0.9 })
    const r = await holds.hold({ accountId: "acct", key: "c", amount: 1_000 })
    if (!r.ok) throw new Error("hold")
    expect(holds.checkpoint(r.hold, 500).action).toBe("warn")
    expect(holds.checkpoint(r.hold, 900).action).toBe("cutoff")
  })
})
