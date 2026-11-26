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
    expect(await s.debit.debit({ accountId: "acct", key: "a1", amount: 300, shortfall: "absorb" })).toMatchObject({ ok: true, charged: 300, shortfall: 0, replayed: false })
    expect(await bal(s)).toBe(700)
  })
  it("is idempotent by key: a replay writes nothing and reports the same charge", async () => {
    const s = await setup([mint("l1", 1_000)])
    await s.debit.debit({ accountId: "acct", key: "a1", amount: 300, shortfall: "absorb" })
    const again = await s.debit.debit({ accountId: "acct", key: "a1", amount: 300, shortfall: "absorb" })
    expect(again).toMatchObject({ ok: true, charged: 300, shortfall: 0, replayed: true })
    expect(await bal(s)).toBe(700)
    expect((await s.storage.loadEvents("acct")).filter(e => e.kind === "burn")).toHaveLength(1)
  })
  it("two concurrent calls with one key write once", async () => {
    const s = await setup([mint("l1", 1_000)])
    await Promise.all([1, 2, 3].map(() => s.debit.debit({ accountId: "acct", key: "same", amount: 100, shortfall: "absorb" })))
    expect(await bal(s)).toBe(900)
  })
  it("draws the lot that expires first", async () => {
    const s = await setup([mint("late", 500, { expiresAt: T0 + 9_000_000 }), mint("soon", 500, { expiresAt: T0 + 1_000_000 })])
    await s.debit.debit({ accountId: "acct", key: "a1", amount: 400, shortfall: "absorb" })
    const burns = (await s.storage.loadEvents("acct")).filter(e => e.kind === "burn")
    expect(burns.map(b => [b.lotId, b.amount])).toEqual([["soon", 400]])
  })
  it("spans lots when one is not enough", async () => {
    const s = await setup([mint("soon", 300, { expiresAt: T0 + 1_000_000 }), mint("late", 500, { expiresAt: T0 + 9_000_000 })])
    const r = await s.debit.debit({ accountId: "acct", key: "a1", amount: 600, shortfall: "absorb" })
    expect(r).toMatchObject({ ok: true, charged: 600, shortfall: 0 })
    expect((await s.storage.loadEvents("acct")).filter(e => e.kind === "burn").map(b => [b.lotId, b.amount])).toEqual([["soon", 300], ["late", 300]])
  })
  it("skips an expired lot", async () => {
    const s = await setup([mint("old", 500, { expiresAt: T0 - 1 }), mint("ok", 100)])
    expect(await s.debit.debit({ accountId: "acct", key: "a1", amount: 300, shortfall: "refuse" })).toMatchObject({ ok: false, reason: "insufficient_funds" })
  })
})

describe("debit: shortfall is the caller's named choice", () => {
  it("refuse writes nothing when the account cannot cover the amount", async () => {
    const s = await setup([mint("l1", 200)])
    expect(await s.debit.debit({ accountId: "acct", key: "a1", amount: 300, shortfall: "refuse" })).toMatchObject({ ok: false, reason: "insufficient_funds" })
    expect(await bal(s)).toBe(200)
    expect((await s.storage.loadEvents("acct")).filter(e => e.kind === "burn")).toHaveLength(0)
  })
  it("absorb charges what is there and reports the unrecovered rest", async () => {
    const s = await setup([mint("l1", 200)])
    expect(await s.debit.debit({ accountId: "acct", key: "a1", amount: 300, shortfall: "absorb" })).toMatchObject({ ok: true, charged: 200, shortfall: 100, replayed: false })
    expect(await bal(s)).toBe(0)
  })
  it("absorb on an empty account charges nothing and writes nothing", async () => {
    const s = await setup([])
    expect(await s.debit.debit({ accountId: "acct", key: "a1", amount: 300, shortfall: "absorb" })).toMatchObject({ ok: true, charged: 0, shortfall: 300, replayed: false })
    expect(await s.storage.loadEvents("acct")).toHaveLength(0)
  })
  it("a prepaid lot never goes negative; a postpaid lot (negative floor) goes down to its floor, no further", async () => {
    const pre = await setup([mint("l1", 100)])
    await pre.debit.debit({ accountId: "acct", key: "a1", amount: 1_000, shortfall: "absorb" })
    expect(await bal(pre)).toBe(0)
    const post = await setup([mint("l1", 0, { floor: -500 })])
    expect(await post.debit.debit({ accountId: "acct", key: "a1", amount: 400, shortfall: "refuse" })).toMatchObject({ ok: true, charged: 400 })
    expect(await post.debit.debit({ accountId: "acct", key: "a2", amount: 400, shortfall: "refuse" })).toMatchObject({ ok: false, reason: "insufficient_funds" })
    expect(await post.debit.debit({ accountId: "acct", key: "a3", amount: 400, shortfall: "absorb" })).toMatchObject({ ok: true, charged: 100, shortfall: 300 })
  })
})

describe("debit: inputs", () => {
  it("refuses a missing key and a non-positive or non-finite amount", async () => {
    const s = await setup([mint("l1", 100)])
    expect(await s.debit.debit({ accountId: "acct", key: "", amount: 10, shortfall: "absorb" })).toMatchObject({ ok: false, reason: "invalid_key" })
    for (const amount of [0, -5, Number.NaN, 0.4, 1.9, 99.99]) expect(await s.debit.debit({ accountId: "acct", key: "k", amount, shortfall: "absorb" })).toMatchObject({ ok: false, reason: "invalid_amount" })
    expect(await bal(s)).toBe(100)
  })
  it("writes the cause on the burn events", async () => {
    const s = await setup([mint("l1", 100)])
    await s.debit.debit({ accountId: "acct", key: "a1", amount: 10, cause: "turn:42", shortfall: "absorb" })
    expect(((await s.storage.loadEvents("acct")).find(e => e.kind === "burn") as WalletEvent & { cause?: string }).cause).toBe("turn:42")
  })
})

describe("debit: replay and foreign burns", () => {
  it("a burn written by another flow under the same correlation id is not taken for a replay", async () => {
    const s = await setup([mint("l1", 1_000)])
    await s.storage.commit("acct", [{ id: "other:burn", accountId: "acct", kind: "burn", asset: ASSET, partitionId: "main", restriction: [], amount: 50, lotId: "l1", correlationId: "turn-42", occurredAt: T0 }])
    expect(await s.debit.debit({ accountId: "acct", key: "turn-42", amount: 500, shortfall: "absorb" })).toMatchObject({ ok: true, charged: 500, shortfall: 0, replayed: false })
    expect(await bal(s)).toBe(450)
  })
  it("a debit that charged nothing leaves no trace: the same key can charge after a top-up", async () => {
    const s = await setup([])
    expect(await s.debit.debit({ accountId: "acct", key: "a1", amount: 300, shortfall: "absorb" })).toMatchObject({ charged: 0, shortfall: 300 })
    await s.storage.commit("acct", [mint("l1", 1_000)])
    expect(await s.debit.debit({ accountId: "acct", key: "a1", amount: 300, shortfall: "absorb" })).toMatchObject({ charged: 300, replayed: false })
  })
  it("a replay with another amount returns the first charge", async () => {
    const s = await setup([mint("l1", 1_000)])
    await s.debit.debit({ accountId: "acct", key: "k", amount: 100, shortfall: "absorb" })
    expect(await s.debit.debit({ accountId: "acct", key: "k", amount: 900, shortfall: "absorb" })).toMatchObject({ charged: 100, shortfall: 0, replayed: true })
    expect(await bal(s)).toBe(900)
  })
  it("only the lots the filter allows are drawn", async () => {
    const clock = new ManualClock(T0)
    const storage = new InMemoryStorage(clock)
    await storage.commit("acct", [mint("promo", 500, { expiresAt: T0 + 1_000, restriction: ["promo"] }), mint("plain", 100)])
    const d = createDebit({ storage, clock }, { asset: ASSET, lotFilter: l => l.restriction.length === 0 })
    expect(await d.debit({ accountId: "acct", key: "k", amount: 300, shortfall: "absorb" })).toMatchObject({ charged: 100, shortfall: 200 })
  })
})

describe("debit: rules decide, the core executes", () => {
  it("a named rule that lowers the amount is executed and reported", async () => {
    const clock = new ManualClock(T0)
    const storage = new InMemoryStorage(clock)
    await storage.commit("acct", [mint("l", 1_000)])
    const d = createDebit({ storage, clock }, { asset: ASSET, rules: [{ name: "per-call-max", decide: c => (c.requested > 50 ? { amount: 50 } : undefined) }] })
    expect(await d.debit({ accountId: "acct", key: "k", amount: 80, shortfall: "refuse" })).toMatchObject({ ok: true, charged: 50, decidedBy: "per-call-max" })
  })
  it("duplicate or unnamed rules are refused at construction", () => {
    const clock = new ManualClock(T0)
    const storage = new InMemoryStorage(clock)
    const r = { name: "a", decide: () => undefined }
    expect(() => createDebit({ storage, clock }, { asset: ASSET, rules: [r, r] })).toThrowError(/duplicate rule name 'a'/)
  })
})

describe("debit: rule composition", () => {
  const setup2 = async (rules: Parameters<typeof createDebit>[1]["rules"]) => {
    const clock = new ManualClock(T0)
    const storage = new InMemoryStorage(clock)
    await storage.commit("acct", [mint("l", 1_000)])
    return { storage, d: createDebit({ storage, clock }, { asset: ASSET, rules }) }
  }
  it("a refusal placed after a lowering rule still sees the lowered amount", async () => {
    const s = await setup2([{ name: "max-50", decide: c => (c.requested > 50 ? { amount: 50 } : undefined) }, { name: "no-over-30", decide: c => (c.requested > 30 ? { refuse: "over 30" } : undefined) }])
    expect(await s.d.debit({ accountId: "acct", key: "k", amount: 100, shortfall: "refuse" })).toMatchObject({ ok: false, rule: "no-over-30" })
  })
  it("two lowering rules compose to the lowest, and the last to lower is named", async () => {
    const s = await setup2([{ name: "a", decide: c => (c.requested > 80 ? { amount: 80 } : undefined) }, { name: "b", decide: c => (c.requested > 40 ? { amount: 40 } : undefined) }])
    const r = await s.d.debit({ accountId: "acct", key: "k", amount: 100, shortfall: "refuse" })
    expect(r).toMatchObject({ ok: true, charged: 40, decidedBy: "b" })
    expect(r.trace.map(t => t.outcome)).toEqual(["decided", "decided"])
  })
  it("an answer that is not a decision refuses, whatever its truthiness", async () => {
    for (const bad of [null, 0, false, ""]) {
      const s = await setup2([{ name: "odd", decide: () => bad as never }])
      expect(await s.d.debit({ accountId: "acct", key: "k", amount: 10, shortfall: "refuse" })).toMatchObject({ ok: false, reason: "invalid_decision", rule: "odd" })
    }
  })
  it("a rule cannot change the stored journal through the snapshot", async () => {
    const s = await setup2([{ name: "meddler", decide: c => { try { (c.history[0]!.restriction as string[]).push("x") } catch { /* frozen */ } return undefined } }])
    await s.d.debit({ accountId: "acct", key: "k", amount: 10, shortfall: "refuse" })
    expect((await s.storage.loadEvents("acct"))[0]!.restriction).toEqual([])
  })
})
