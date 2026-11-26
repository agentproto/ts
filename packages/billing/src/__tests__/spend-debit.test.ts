import type { WalletEvent } from "@agentproto/wallet"
import { describe, expect, it } from "vitest"
import { createDebit } from "../spend/index.js"
import { InMemoryStorage, ManualClock } from "../testing/index.js"

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0)
const ASSET = "credits"
const mint = (lot: string, amount: number, extra: Partial<WalletEvent> = {}): WalletEvent => ({
  id: `mint:${lot}`, accountId: "acct", kind: "mint", asset: ASSET, partitionId: "main", restriction: [], amount, lotId: lot, occurredAt: T0, ...extra,
})
async function setup(mints: WalletEvent[]) {
  const clock = new ManualClock(T0)
  const storage = new InMemoryStorage(clock)
  if (mints.length) await storage.commit("acct", mints)
  return { clock, storage, debit: createDebit({ storage, clock }, { asset: ASSET }) }
}
const bal = (s: { storage: InMemoryStorage }) => s.storage.spendableBalance("acct", ASSET)

describe("debit: a direct spend on the journal's burn verb", () => {
  it("burns the amount and lowers the balance", async () => {
    const s = await setup([mint("l1", 1_000)])
    expect(await s.debit.debit({ accountId: "acct", key: "a1", amount: 300 })).toEqual({ ok: true, charged: 300, shortfall: 0, replayed: false })
    expect(await bal(s)).toBe(700)
  })
  it("is idempotent by key: a replay writes nothing and reports the same charge", async () => {
    const s = await setup([mint("l1", 1_000)])
    await s.debit.debit({ accountId: "acct", key: "a1", amount: 300 })
    const again = await s.debit.debit({ accountId: "acct", key: "a1", amount: 300 })
    expect(again).toEqual({ ok: true, charged: 300, shortfall: 0, replayed: true })
    expect(await bal(s)).toBe(700)
    expect((await s.storage.loadEvents("acct")).filter(e => e.kind === "burn")).toHaveLength(1)
  })
  it("two concurrent calls with one key write once", async () => {
    const s = await setup([mint("l1", 1_000)])
    await Promise.all([1, 2, 3].map(() => s.debit.debit({ accountId: "acct", key: "same", amount: 100 })))
    expect(await bal(s)).toBe(900)
  })
  it("draws the lot that expires first", async () => {
    const s = await setup([mint("late", 500, { expiresAt: T0 + 9_000_000 }), mint("soon", 500, { expiresAt: T0 + 1_000_000 })])
    await s.debit.debit({ accountId: "acct", key: "a1", amount: 400 })
    const burns = (await s.storage.loadEvents("acct")).filter(e => e.kind === "burn")
    expect(burns.map(b => [b.lotId, b.amount])).toEqual([["soon", 400]])
  })
  it("spans lots when one is not enough", async () => {
    const s = await setup([mint("soon", 300, { expiresAt: T0 + 1_000_000 }), mint("late", 500, { expiresAt: T0 + 9_000_000 })])
    const r = await s.debit.debit({ accountId: "acct", key: "a1", amount: 600 })
    expect(r).toMatchObject({ ok: true, charged: 600, shortfall: 0 })
    expect((await s.storage.loadEvents("acct")).filter(e => e.kind === "burn").map(b => [b.lotId, b.amount])).toEqual([["soon", 300], ["late", 300]])
  })
  it("skips an expired lot", async () => {
    const s = await setup([mint("old", 500, { expiresAt: T0 - 1 }), mint("ok", 100)])
    expect(await s.debit.debit({ accountId: "acct", key: "a1", amount: 300, shortfall: "refuse" })).toEqual({ ok: false, reason: "insufficient_funds" })
  })
})

describe("debit: shortfall is the caller's named choice", () => {
  it("refuse writes nothing when the account cannot cover the amount", async () => {
    const s = await setup([mint("l1", 200)])
    expect(await s.debit.debit({ accountId: "acct", key: "a1", amount: 300, shortfall: "refuse" })).toEqual({ ok: false, reason: "insufficient_funds" })
    expect(await bal(s)).toBe(200)
    expect((await s.storage.loadEvents("acct")).filter(e => e.kind === "burn")).toHaveLength(0)
  })
  it("absorb charges what is there and reports the unrecovered rest", async () => {
    const s = await setup([mint("l1", 200)])
    expect(await s.debit.debit({ accountId: "acct", key: "a1", amount: 300 })).toEqual({ ok: true, charged: 200, shortfall: 100, replayed: false })
    expect(await bal(s)).toBe(0)
  })
  it("absorb on an empty account charges nothing and writes nothing", async () => {
    const s = await setup([])
    expect(await s.debit.debit({ accountId: "acct", key: "a1", amount: 300 })).toEqual({ ok: true, charged: 0, shortfall: 300, replayed: false })
    expect(await s.storage.loadEvents("acct")).toHaveLength(0)
  })
  it("a prepaid lot never goes negative; a postpaid lot (negative floor) goes down to its floor, no further", async () => {
    const pre = await setup([mint("l1", 100)])
    await pre.debit.debit({ accountId: "acct", key: "a1", amount: 1_000 })
    expect(await bal(pre)).toBe(0)
    const post = await setup([mint("l1", 0, { floor: -500 })])
    expect(await post.debit.debit({ accountId: "acct", key: "a1", amount: 400, shortfall: "refuse" })).toMatchObject({ ok: true, charged: 400 })
    expect(await post.debit.debit({ accountId: "acct", key: "a2", amount: 400, shortfall: "refuse" })).toEqual({ ok: false, reason: "insufficient_funds" })
    expect(await post.debit.debit({ accountId: "acct", key: "a3", amount: 400 })).toMatchObject({ ok: true, charged: 100, shortfall: 300 })
  })
})

describe("debit: inputs", () => {
  it("refuses a missing key and a non-positive or non-finite amount", async () => {
    const s = await setup([mint("l1", 100)])
    expect(await s.debit.debit({ accountId: "acct", key: "", amount: 10 })).toEqual({ ok: false, reason: "invalid_key" })
    for (const amount of [0, -5, Number.NaN, 0.4]) expect(await s.debit.debit({ accountId: "acct", key: "k", amount })).toEqual({ ok: false, reason: "invalid_amount" })
    expect(await bal(s)).toBe(100)
  })
  it("writes the cause on the burn events", async () => {
    const s = await setup([mint("l1", 100)])
    await s.debit.debit({ accountId: "acct", key: "a1", amount: 10, cause: "turn:42" })
    expect(((await s.storage.loadEvents("acct")).find(e => e.kind === "burn") as WalletEvent & { cause?: string }).cause).toBe("turn:42")
  })
})

describe("debit: replay and foreign burns", () => {
  it("a burn written by another flow under the same correlation id is not taken for a replay", async () => {
    const s = await setup([mint("l1", 1_000)])
    await s.storage.commit("acct", [{ id: "other:burn", accountId: "acct", kind: "burn", asset: ASSET, partitionId: "main", restriction: [], amount: 50, lotId: "l1", correlationId: "turn-42", occurredAt: T0 }])
    expect(await s.debit.debit({ accountId: "acct", key: "turn-42", amount: 500 })).toEqual({ ok: true, charged: 500, shortfall: 0, replayed: false })
    expect(await bal(s)).toBe(450)
  })
  it("a debit that charged nothing leaves no trace: the same key can charge after a top-up", async () => {
    const s = await setup([])
    expect(await s.debit.debit({ accountId: "acct", key: "a1", amount: 300 })).toMatchObject({ charged: 0, shortfall: 300 })
    await s.storage.commit("acct", [mint("l1", 1_000)])
    expect(await s.debit.debit({ accountId: "acct", key: "a1", amount: 300 })).toMatchObject({ charged: 300, replayed: false })
  })
  it("a replay with another amount returns the first charge", async () => {
    const s = await setup([mint("l1", 1_000)])
    await s.debit.debit({ accountId: "acct", key: "k", amount: 100 })
    expect(await s.debit.debit({ accountId: "acct", key: "k", amount: 900 })).toMatchObject({ charged: 100, replayed: true })
    expect(await bal(s)).toBe(900)
  })
  it("only the lots the filter allows are drawn", async () => {
    const clock = new ManualClock(T0)
    const storage = new InMemoryStorage(clock)
    await storage.commit("acct", [mint("promo", 500, { expiresAt: T0 + 1_000, restriction: ["promo"] }), mint("plain", 100)])
    const d = createDebit({ storage, clock }, { asset: ASSET, lotFilter: l => l.restriction.length === 0 })
    expect(await d.debit({ accountId: "acct", key: "k", amount: 300 })).toMatchObject({ charged: 100, shortfall: 200 })
  })
})
