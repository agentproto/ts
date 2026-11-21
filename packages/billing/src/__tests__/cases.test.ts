/**
 * The eleven real cases of PLAN-BILLING-FINAL section 5, one test each, run on
 * the four product files of the AIP-BILLING draft (fixtures) and on the in-memory
 * stores. The table case -> test is in the pull request description.
 */
import { fold, selectLotsForSpend, type WalletEvent } from "@agentproto/wallet"
import type { StoragePort } from "@agentproto/wallet/ports"
import { describe, expect, it } from "vitest"
import {
  addMonthsUtc,
  applyDispute,
  applyPayment,
  applyRefund,
  applyTransfer,
  canPay,
  convertMinor,
  failRenewal,
  handleWebhook,
  listOwed,
  loadBillingManifestForTest,
  resolvePayer,
  sweepGrace,
  traceOf,
  type AccountDirectory,
  type BillingDeps,
  type CauseEvent,
  type PaymentFact,
  type TransferRequest,
} from "./cases-kit.js"
import { FakeSettlementProvider, InMemoryBillingState, InMemoryStorage, ManualClock } from "../testing/index.js"

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0)
const DAY = 86_400_000

interface World {
  m: ReturnType<typeof loadBillingManifestForTest>
  deps: BillingDeps
  storage: InMemoryStorage
  state: InMemoryBillingState
  clock: ManualClock
  provider: FakeSettlementProvider
  pay: (offerId: string, amountMinor: number, currency: string, owner: Record<string, string>, extra?: Partial<PaymentFact>) => PaymentFact
}

function world(name: string, rail: string, edit?: (source: string) => string): World {
  const clock = new ManualClock(T0)
  const storage = new InMemoryStorage(clock)
  const state = new InMemoryBillingState()
  const m = loadBillingManifestForTest(name, edit)
  const provider = new FakeSettlementProvider(`whsec-${globalThis.crypto.randomUUID()}`, rail)
  let n = 0
  return {
    m,
    deps: { manifest: m, storage, clock, state },
    storage,
    state,
    clock,
    provider,
    pay: (offerId, amountMinor, currency, owner, extra = {}) => ({
      type: "payment",
      movement: `${rail}:pi_${name}_${++n}`,
      rail,
      offerId,
      owner,
      amountMinor,
      taxMinor: 0,
      currency,
      paidAt: clock.nowMs(),
      ...extra,
    }),
  }
}

const lots = async (w: World, account: string) => fold(await w.storage.loadEvents(account), w.clock.nowMs())
const balance = async (w: World, account: string, asset = w.m.primaryAsset) =>
  (await lots(w, account))
    .filter(l => l.asset === asset && !(l.expiresAt !== undefined && l.expiresAt <= w.clock.nowMs()))
    .reduce((s, l) => s + l.remaining - l.reserved, 0)

describe("case 1: Simone, a 20 EUR pack", () => {
  it("mints the fiat, converts at the derived rate, adds a separate bonus lot, and a refund takes back at most the purchased remainder, never the bonus", async () => {
    const w = world("simone", "stripe")
    const f = w.pay("credits_2400", 2000, "EUR", { userId: "u1" })
    const out = await applyPayment(w.deps, f)
    expect(out.status).toBe("applied")
    const trace = await traceOf(w.storage, "u1", f.movement)
    expect(trace.map(e => e.kind)).toEqual(["mint", "convert_out", "convert_in", "mint"])
    expect(trace.every(e => e.cause === f.movement)).toBe(true)
    expect(trace[0]).toMatchObject({ asset: "EUR", amount: 2000, externalRef: f.movement })
    const ls = await lots(w, "u1")
    expect(ls.find(l => l.partitionId === "SIMONE_CREDITS:purchased")?.original).toBe(236_000)
    expect(ls.find(l => l.partitionId === "SIMONE_CREDITS:bonus")?.original).toBe(47_200)
    await w.storage.spend("u1", "SIMONE_CREDITS", 200_000, "spent")
    const r = await applyRefund(w.deps, { type: "refund", movement: "stripe:re_1", rail: "stripe", paymentMovement: f.movement, amountMinor: 2000, at: T0 }, { accountId: "u1" })
    expect(r.reclaimed).toBe(36_000)
    expect((await lots(w, "u1")).find(l => l.partitionId === "SIMONE_CREDITS:bonus")?.remaining).toBe(47_200)
  })
})

describe("case 2: Simone, a subscription and a pack are two payments with two causes", () => {
  it("the plan credits reset at the period end (with its grace), the pack credits never do, and 'what became of these 20 EUR' has two answers", async () => {
    const w = world("simone", "stripe")
    const plan = w.pay("simone_go_month_eur", 500, "EUR", { userId: "u2" })
    const pack = w.pay("credits_2400", 2000, "EUR", { userId: "u2" })
    await applyPayment(w.deps, plan)
    await applyPayment(w.deps, pack)
    const t1 = await traceOf(w.storage, "u2", plan.movement)
    const t2 = await traceOf(w.storage, "u2", pack.movement)
    expect(t1.some(e => e.partitionId === "SIMONE_CREDITS:subscription")).toBe(true)
    expect(t2.some(e => e.partitionId === "SIMONE_CREDITS:purchased")).toBe(true)
    expect(t1.some(e => e.partitionId === "SIMONE_CREDITS:purchased")).toBe(false)
    expect(await balance(w, "u2")).toBe(60_000 + 236_000 + 47_200)
    w.clock.set(addMonthsUtc(Date.UTC(2026, 10, 1), 1) + 8 * DAY) // after the period end and the 7 day grace
    expect(await balance(w, "u2")).toBe(236_000 + 47_200)
  })
})

describe("case 3: Simone, points to credits", () => {
  it("is a disabled conversion with a decimals-aware rate, checked for arbitrage, with no path to fiat", () => {
    const m = loadBillingManifestForTest("simone")
    const c = m.derived.conversions.get("points-to-credits")!
    expect(c.enabled).toBe(false)
    expect(convertMinor(100, c.ratio, c.fromDecimals, c.toDecimals)).toBe(10_000) // 100 points -> 100 credits in hundredths
    for (const conv of m.derived.conversions.values()) expect(/^[A-Z]{3}$/.test(conv.to)).toBe(false)
    expect(() => loadBillingManifestForTest("simone", s => s.replace("  - id: points-to-credits", "  - id: credits-to-eur\n    from: SIMONE_CREDITS\n    to: EUR\n    rate: { kind: fixed, ratio: 0.01 }\n    mint: { partition: \"EUR:default\" }\n  - id: points-to-credits"))).toThrow(/fiat|rule 11/)
  })
})

describe("case 4: Guilde, an organization funds its guilds; packs in EUR and USD are two prices at the anchor", () => {
  it("prices the same pack in both currencies, allocates org to guild and refuses reclaim", async () => {
    const w = world("guilde", "stripe")
    const eur = w.pay("starter_eur", 1000, "EUR", { organizationId: "org", guildId: "g", userId: "u" })
    const usd = w.pay("starter_usd", 1000, "USD", { organizationId: "org", guildId: "g", userId: "u2" })
    await applyPayment(w.deps, eur)
    await applyPayment(w.deps, usd)
    expect(await balance(w, "org:g:u")).toBe(118_000 + 11_800) // 10 EUR at 118, +10 percent
    expect(await balance(w, "org:g:u2")).toBe(100_000 + 10_000) // 10 USD at 100, +10 percent
    const moved = await applyTransfer(w.deps, { kind: "allocate", ref: "alloc-1", parentId: "org:g:u", childId: "guild-1", amount: 50_000 })
    expect(moved).toMatchObject({ status: "applied", moved: 50_000 })
    expect(await balance(w, "guild-1")).toBe(50_000)
    expect((await applyTransfer(w.deps, { kind: "reclaim", ref: "reclaim-1", parentId: "org:g:u", childId: "guild-1", amount: 1 })).status).toBe("refused")
    expect((await applyTransfer(w.deps, { kind: "allocate", ref: "alloc-1", parentId: "org:g:u", childId: "guild-1", amount: 50_000 })).status).toBe("replayed")
  })
  it("resolves the payer by organization kind through a registered vendor strategy", async () => {
    const w = world("guilde", "stripe")
    const dir: AccountDirectory = { get: async id => (id === "me" ? { id: "me", parentId: null } : null) }
    const strat = { "x-agentik:org-kind": async (id: string) => ({ ok: true as const, payerId: id, path: [id] }) }
    expect(await resolvePayer(w.m, dir, "me", strat)).toMatchObject({ ok: true, payerId: "me" })
    expect(await resolvePayer(w.m, dir, "me")).toMatchObject({ ok: false })
  })
  it("a crash between the two commits loses nothing: the retry mints the child leg from the recorded out leg", async () => {
    const w = world("guilde", "stripe")
    await applyPayment(w.deps, w.pay("starter_eur", 1000, "EUR", { organizationId: "org", guildId: "g", userId: "u" }))
    const req: TransferRequest = { kind: "allocate", ref: "alloc-crash", parentId: "org:g:u", childId: "guild-crash", amount: 50_000 }
    // A storage that dies after the source leg was committed, before the destination leg.
    const crash: StoragePort = Object.create(w.storage) as StoragePort
    crash.commit = async (accountId: string, events: readonly WalletEvent[]): Promise<void> => {
      if (accountId === req.childId) throw new Error("crash between the two commits")
      return w.storage.commit(accountId, events)
    }
    await expect(applyTransfer({ ...w.deps, storage: crash }, req)).rejects.toThrow(/crash/)
    expect(await balance(w, "org:g:u")).toBe(118_000 + 11_800 - 50_000) // the source leg is committed
    expect(await balance(w, "guild-crash")).toBe(0) // the destination leg is not
    const retry = await applyTransfer(w.deps, req)
    expect(retry.status).toBe("replayed")
    expect(await balance(w, "guild-crash")).toBe(50_000) // repaired from the recorded out leg
    const ins = (await w.storage.loadEvents("guild-crash")) as CauseEvent[]
    expect(ins.filter(e => e.id.startsWith("alloc-crash:in:"))).toHaveLength(1)
    expect(ins.find(e => e.id.startsWith("alloc-crash:in:"))).toMatchObject({ kind: "mint", amount: 50_000, cause: "alloc-crash" })
    const n = ins.length
    expect((await applyTransfer(w.deps, req)).status).toBe("replayed")
    expect((await w.storage.loadEvents("guild-crash")).length).toBe(n) // still idempotent
  })
})

describe("case 5: ChatCommerce, plans excluding tax and a free amount with a volume bonus", () => {
  it("gives a plan its included credits and rights, bonus tiers 5 / 10 / 15 percent on the net amount, and 12 month validity", async () => {
    const w = world("chatcommerce", "stripe")
    const plan = w.pay("visibilite", 7900, "EUR", { orgId: "o1" })
    await applyPayment(w.deps, plan)
    expect(await balance(w, "o1")).toBe(1_030_000)
    for (const [amount, pct] of [[6000, 5], [12000, 10], [30001, 15], [5999, 0]] as const) {
      const w2 = world("chatcommerce", "stripe")
      const f = w2.pay("credits", amount, "EUR", { orgId: `o${amount}` }, { taxMinor: 0 })
      await applyPayment(w2.deps, f)
      const base = Math.floor((amount * 118))
      expect(await balance(w2, `o${amount}`)).toBe(base + Math.floor((base * pct) / 100))
    }
    const w3 = world("chatcommerce", "stripe")
    await applyPayment(w3.deps, w3.pay("credits", 10_000, "EUR", { orgId: "o3" }))
    const purchased = (await lots(w3, "o3")).find(l => l.partitionId === "CHATCOMMERCE_CREDITS:purchased")!
    expect(purchased.expiresAt).toBe(addMonthsUtc(T0, 12))
    w3.clock.set(addMonthsUtc(T0, 12) + 1)
    expect(await balance(w3, "o3", "CHATCOMMERCE_CREDITS")).toBe(0)
  })
  it("converts the net amount when the price excludes tax, and refuses an amount outside the buyer bounds", async () => {
    const w = world("chatcommerce", "stripe")
    await applyPayment(w.deps, w.pay("credits", 12_000, "EUR", { orgId: "o" }, { taxMinor: 2000 }))
    expect(await balance(w, "o")).toBe(10_000 * 118 + Math.floor((10_000 * 118 * 5) / 100)) // net 10 000 -> 5 percent tier
    const low = await applyPayment(w.deps, w.pay("credits", 999, "EUR", { orgId: "o2" }))
    expect(low.status).toBe("refused")
  })
})

describe("case 6: ChatCommerce agencies", () => {
  it("an agency allocates to a client, the client pays from its allocation and never from the agency pot (no cascade)", async () => {
    const w = world("chatcommerce", "stripe")
    await applyPayment(w.deps, w.pay("credits", 10_000, "EUR", { orgId: "agency" }))
    await applyTransfer(w.deps, { kind: "allocate", ref: "a1", parentId: "agency", childId: "client", amount: 100_000 })
    const dir: AccountDirectory = {
      get: async id => ({ agency: { id: "agency", parentId: null, funding: "allocated_budget" as const }, client: { id: "client", parentId: "agency" } })[id as "agency" | "client"] ?? null,
    }
    const r = await resolvePayer(w.m, dir, "client")
    expect(r).toMatchObject({ ok: true, payerId: "client" })
    if (r.ok) {
      expect(await canPay(w.m, w.storage, r.payerId, 100_000, T0)).toBe(true)
      expect(await canPay(w.m, w.storage, r.payerId, 100_001, T0)).toBe(false) // the agency pot is not drawn
    }
    expect((await applyTransfer(w.deps, { kind: "reclaim", ref: "r1", parentId: "agency", childId: "client", amount: 40_000 })).status).toBe("applied")
    expect(await balance(w, "client")).toBe(60_000)
  })
})

describe("case 7: a 50 EUR pack with a +30 percent bonus (Katchy has the same form; its file is not among the four)", () => {
  it("gives the bonus as a separate lot that a refund never takes back", async () => {
    const w = world("simone", "stripe")
    const f = w.pay("credits_7500", 5000, "EUR", { userId: "k" })
    await applyPayment(w.deps, f)
    expect((await lots(w, "k")).find(l => l.partitionId === "SIMONE_CREDITS:purchased")?.original).toBe(590_000)
    expect((await lots(w, "k")).find(l => l.partitionId === "SIMONE_CREDITS:bonus")?.original).toBe(177_000)
    await applyRefund(w.deps, { type: "refund", movement: "stripe:re_k", rail: "stripe", paymentMovement: f.movement, amountMinor: 5000, at: T0 }, { accountId: "k" })
    expect(await balance(w, "k")).toBe(177_000)
  })
})

describe("case 8: Agentik SEO, its own anchor, decimals 0, two partitions", () => {
  it("converts 1 USD to 1 000 credits with no decimals, spends the monthly allowance first, and the bundle is a one-time purchase", async () => {
    const w = world("agentik-seo", "autumn")
    expect(convertMinor(100, w.m.derived.conversions.get("usd-to-credits")!.ratio, 2, 0)).toBe(1000)
    await applyPayment(w.deps, w.pay("credit-top-up", 500, "USD", { organizationId: "s" }))
    await applyPayment(w.deps, w.pay("base-plan", 1900, "USD", { organizationId: "s" }))
    expect(await balance(w, "s")).toBe(5000 + 10_000)
    const asset = w.m.derived.assets.get("SEO_CREDITS")!
    const plan = selectLotsForSpend(await w.storage.loadLots("s"), { asset: "SEO_CREDITS", category: "x", amount: 100, now: T0 }, asset, w.m.derived.partitions)
    const drawn = (await lots(w, "s")).find(l => l.id === plan.draws[0]!.lotId)!
    expect(drawn.partitionId).toBe("SEO_CREDITS:monthly")
    expect(w.m.spendOrder).toEqual(["SEO_CREDITS:monthly", "SEO_CREDITS:topup"])
    const b = w.pay("bundle-seo-augmente", 9900, "USD", { organizationId: "b" })
    await applyPayment(w.deps, b)
    expect(await balance(w, "b")).toBe(15_000)
    expect((await traceOf(w.storage, "b", b.movement)).map(e => e.kind)).toEqual(["mint", "burn", "mint"])
  })
})

describe("one-time include rollover (rule 16, schema default none)", () => {
  const TTL = 30 * DAY
  const topupTtl = (src: string) =>
    src.replace(
      '- { id: "SEO_CREDITS:topup",   asset: SEO_CREDITS, restriction: [] }',
      `- { id: "SEO_CREDITS:topup",   asset: SEO_CREDITS, restriction: [], defaultTtlMs: ${TTL} }`,
    )
  const bundleInclude = (rollover?: string) => (src: string) =>
    topupTtl(src).replace(
      '- { feature: credits, amountMinor: 15000, partition: "SEO_CREDITS:topup" }',
      `- { feature: credits, amountMinor: 15000, partition: "SEO_CREDITS:topup"${rollover ? `, rollover: ${rollover}` : ""} }`,
    )
  const includeEvent = async (w: World, movement: string) =>
    ((await traceOf(w.storage, "b", movement)) as CauseEvent[]).find(e => e.id.includes(":incl:"))!

  it("rollover omitted (default none) expires the include with the partition TTL", async () => {
    const w = world("agentik-seo", "autumn", bundleInclude())
    const b = w.pay("bundle-seo-augmente", 9900, "USD", { organizationId: "b" })
    await applyPayment(w.deps, b)
    expect((await includeEvent(w, b.movement)).expiresAt).toBe(T0 + TTL)
  })
  it("rollover none expires it with the partition TTL, unbounded never expires", async () => {
    const wNone = world("agentik-seo", "autumn", bundleInclude("none"))
    const fNone = wNone.pay("bundle-seo-augmente", 9900, "USD", { organizationId: "b" })
    await applyPayment(wNone.deps, fNone)
    expect((await includeEvent(wNone, fNone.movement)).expiresAt).toBe(T0 + TTL)
    const wUnb = world("agentik-seo", "autumn", bundleInclude("unbounded"))
    const fUnb = wUnb.pay("bundle-seo-augmente", 9900, "USD", { organizationId: "b" })
    await applyPayment(wUnb.deps, fUnb)
    expect((await includeEvent(wUnb, fUnb.movement)).expiresAt).toBeUndefined()
  })
  it("with no partition TTL, none and unbounded both keep the include (Agentik SEO topup never expires)", async () => {
    const w = world("agentik-seo", "autumn")
    const b = w.pay("bundle-seo-augmente", 9900, "USD", { organizationId: "b" })
    await applyPayment(w.deps, b)
    expect((await includeEvent(w, b.movement)).expiresAt).toBeUndefined()
  })
})

describe("case 9: a partial refund after spending, a dispute, and a yearly plan refunded at month 2", () => {
  it("treats money and credits apart: partial refund, dispute freeze then reclaim", async () => {
    const w = world("simone", "stripe")
    const f = w.pay("credits_2400", 2000, "EUR", { userId: "d" })
    await applyPayment(w.deps, f)
    await w.storage.spend("d", "SIMONE_CREDITS", 100_000, "s1")
    const r = await applyRefund(w.deps, { type: "refund", movement: "stripe:re_p", rail: "stripe", paymentMovement: f.movement, amountMinor: 1000, at: T0 }, { accountId: "d" })
    expect(r.reclaimed).toBe(118_000) // half of what the payment minted (purchased lot), 136 000 left
    await applyDispute(w.deps, { type: "dispute", movement: "stripe:du_1", rail: "stripe", paymentMovement: f.movement, status: "opened", at: T0 }, { accountId: "d" })
    expect(await w.storage.spendableBalance("d", "SIMONE_CREDITS")).toBe(0)
    await applyDispute(w.deps, { type: "dispute", movement: "stripe:du_1", rail: "stripe", paymentMovement: f.movement, status: "lost", at: T0 }, { accountId: "d" })
    expect(await w.storage.spendableBalance("d", "SIMONE_CREDITS")).toBe(47_200) // only the bonus is left
  })
  // The yearly plan is covered by BILL-REFUND on the reference manifest (the four files sell monthly plans only).
})

describe("case 10: a refused renewal", () => {
  it("stays past_due during the grace with its credits and rights, then closes", async () => {
    const w = world("simone", "stripe")
    const f = w.pay("simone_go_month_eur", 500, "EUR", { userId: "r" })
    await applyPayment(w.deps, f)
    w.clock.set(Date.UTC(2026, 11, 1))
    const p = await failRenewal(w.deps, { accountId: "r", offerId: "simone_go_month_eur" })
    expect(p?.status).toBe("past_due")
    expect(await balance(w, "r")).toBe(60_000) // the credits live through the grace
    w.clock.set(Date.UTC(2026, 11, 1) + 8 * DAY)
    expect((await sweepGrace(w.deps))[0]?.closedReason).toBe("grace_expired")
    expect(await balance(w, "r")).toBe(0)
  })
  it("closes at once when the offer has no grace (ChatCommerce today)", async () => {
    const w = world("chatcommerce", "stripe")
    await applyPayment(w.deps, w.pay("visibilite", 7900, "EUR", { orgId: "c" }))
    const p = await failRenewal(w.deps, { accountId: "c", offerId: "visibilite", at: addMonthsUtc(T0, 1) })
    expect(p?.status).toBe("closed")
    expect(p?.closedReason).toBe("no_grace")
  })
})

describe("case 11: a forged or doubled webhook", () => {
  it("refuses a changed amount and lists the money as owed, and writes once for two events of one payment", async () => {
    const w = world("simone", "stripe")
    const body = { intent: "pi_a", offerId: "credits_2400", owner: { userId: "w" }, amountMinor: 1999, currency: "EUR", at: T0 }
    const bad = await handleWebhook(w.deps, w.provider, w.provider.signed({ ...body, type: "payment_intent.succeeded" }))
    expect(bad).toMatchObject({ type: "payment", outcome: { status: "refused", owedMinor: 1999 } })
    expect((await listOwed(w.storage, "w", T0)).reduce((s, o) => s + o.remaining, 0)).toBe(1999)
    const good = { ...body, intent: "pi_b", amountMinor: 2000 }
    await handleWebhook(w.deps, w.provider, w.provider.signed({ ...good, type: "payment_intent.succeeded" }))
    const n = (await w.storage.loadEvents("w")).length
    const dup = await handleWebhook(w.deps, w.provider, w.provider.signed({ ...good, type: "charge.succeeded" }))
    expect(dup).toMatchObject({ outcome: { status: "replayed" } })
    expect((await w.storage.loadEvents("w")).length).toBe(n)
    await expect(handleWebhook(w.deps, w.provider, { body: JSON.stringify(good), headers: { "x-fake-signature": "forged" } })).rejects.toThrow(/signature/)
  })
})
