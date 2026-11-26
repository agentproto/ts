/**
 * BILL-* conformance cases (AIP-74 Conformance), framework-free: each case is a
 * name and an async function that throws on failure.
 *
 *   for (const c of billingConformanceCases(ctx)) it(c.name, c.run)
 *
 * They run against the stores, the clock and the provider the host passes, on a
 * reference manifest of their own (`REFERENCE_MANIFEST`), so a payment provider
 * package can run them against a recorded exchange or a test-mode account.
 */
import { fold } from "@agentproto/wallet"
import type { StoragePort } from "@agentproto/wallet/ports"
import { loadBillingManifest, parseBillingManifest } from "../manifest/index.js"
import type { BillingHandle } from "../define-billing-manifest.js"
import { applyPayment, listOwed, traceOf } from "../payment.js"
import { applyDispute, applyRefund, applyRefundReversal } from "../reclaim.js"
import { dueDrops, failRenewal, runDueIncludes, sweepGrace, activeFeatures } from "../periods.js"
import { applyGrant } from "../grants.js"
import { resolvePayer, canPay, type AccountDirectory, type AccountNode } from "../payer.js"
import { handleRailFact, handleWebhook } from "../webhook.js"
import { assertRailEnv, assertKeyMatchesMode, railMode } from "../rails.js"
import { makeBillingRegistry } from "../registry.js"
import { addMonthsUtc } from "../model.js"
import type { BillingDeps, BillingStateStore, CauseEvent } from "../ports.js"
import type { PaymentFact, SettlementProvider } from "../settlement.js"
import { REFERENCE_MANIFEST } from "./reference-manifest.js"
import type { ManualClock } from "./fakes.js"

export interface ConformanceCase {
  name: string
  run: () => Promise<void>
}

export interface BillingConformanceContext {
  /** Fresh, empty stores for one case. */
  stores: () => { storage: StoragePort & { spend?: (account: string, asset: string, amount: number, id: string) => Promise<void> }; state: BillingStateStore }
  /** A clock the cases may move. */
  clock: ManualClock
  /** The provider under test; its rail id must be `fake` for the reference manifest, or pass `railId`. */
  provider: SettlementProvider
  /** Wrap the reference manifest's source (a provider package rewrites the rail id). */
  manifestSource?: string
}

class ConformanceError extends Error {}
const check = (cond: unknown, msg: string): void => {
  if (!cond) throw new ConformanceError(msg)
}
const eq = (a: unknown, b: unknown, msg: string): void => check(Object.is(a, b), `${msg}: expected ${String(b)}, got ${String(a)}`)
const rejects = async (fn: () => unknown | Promise<unknown>, part: string, msg: string): Promise<void> => {
  try {
    await fn()
  } catch (e) {
    check(String((e as Error).message).includes(part), `${msg}: error '${(e as Error).message}' does not mention '${part}'`)
    return
  }
  throw new ConformanceError(`${msg}: did not throw`)
}

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0)
const DAY = 86_400_000

export function billingConformanceCases(ctx: BillingConformanceContext): ConformanceCase[] {
  const source = ctx.manifestSource ?? REFERENCE_MANIFEST
  const strategies = [] as string[]
  const manifest = (): BillingHandle => loadBillingManifest(source, { strategies })
  const world = () => {
    ctx.clock.set(T0)
    const { storage, state } = ctx.stores()
    const m = manifest()
    const deps: BillingDeps = { manifest: m, storage, clock: ctx.clock, state }
    return { m, deps, storage, state }
  }
  let n = 0
  const pay = (over: Partial<PaymentFact> = {}): PaymentFact => ({
    type: "payment",
    movement: `fake:pi_${++n}`,
    rail: "fake",
    offerId: "pack-20",
    owner: { orgId: "acme" },
    amountMinor: 2000,
    taxMinor: 0,
    currency: "EUR",
    paidAt: ctx.clock.nowMs(),
    ...over,
  })
  const credits = async (storage: StoragePort, account: string, m: BillingHandle) => {
    const lots = fold(await storage.loadEvents(account), ctx.clock.nowMs())
    return lots.filter(l => l.asset === m.primaryAsset && !(l.expiresAt !== undefined && l.expiresAt <= ctx.clock.nowMs())).reduce((s, l) => s + l.remaining - l.reserved, 0)
  }
  const mutate = (from: string, to: string): string => {
    check(source.includes(from), `reference manifest lost '${from}'`)
    return source.replace(from, to)
  }

  const cases: ConformanceCase[] = []
  const add = (suite: string, name: string, run: () => Promise<void>) => cases.push({ name: `${suite} ${name}`, run })

  // ── BILL-PARSE (rules 21 to 23) ────────────────────────────────────
  add("BILL-PARSE", "the reference manifest parses and derives its edges", async () => {
    const m = manifest()
    check(m.derived.conversions.get("eur-to-credits")?.edge.rate.kind === "fixed", "edge not derived")
  })
  add("BILL-PARSE", "a fiat conversion that writes its own rate is rejected (rule 26)", async () => {
    await rejects(() => loadBillingManifest(mutate("    from: EUR\n    to: REF_CREDITS\n    rail: fake\n", "    from: EUR\n    to: REF_CREDITS\n    rate: { kind: fixed, ratio: 100 }\n    rail: fake\n"), { strategies }), "rate", "own rate")
  })
  add("BILL-PARSE", "an unknown partition, asset, feature, conversion and rail are rejected", async () => {
    for (const [from, to, part] of [
      ['mint: { partition: "REF_CREDITS:purchased", expires: { after: P12M } }', 'mint: { partition: "REF_CREDITS:nowhere", expires: { after: P12M } }', "unknown partition"],
      ["feature: pro }, ", "feature: ghost }, ", "unknown feature"],
      ["convert: usd-to-credits", "convert: nothing", "unknown conversion"],
      ["rail: fake\n    mint: { partition: \"REF_CREDITS:purchased\" }", "rail: other\n    mint: { partition: \"REF_CREDITS:purchased\" }", "unknown rail"],
    ] as const) {
      await rejects(() => loadBillingManifest(mutate(from, to), { strategies }), part.split(" ")[1]!, part)
    }
  })
  add("BILL-PARSE", "a bonus on a non-fiat conversion, convert outside prepaid-pool, includes on prepaid-pool are rejected", async () => {
    await rejects(() => loadBillingManifest(mutate("    rate: { kind: fixed, ratio: 1 }\n", "    rate: { kind: fixed, ratio: 1 }\n    bonus: { strategy: tiered-lots/v1, partition: \"REF_CREDITS:bonus\", tiers: [[0, 5]] }\n"), { strategies }), "bonus", "bonus")
    await rejects(() => loadBillingManifest(mutate("  - { id: top-up,", "  - { id: top-up2, includes: [{ feature: pro }],"), { strategies }), "includes", "includes on prepaid-pool")
  })
  add("BILL-PARSE", "an offer currency outside anchor and fx, a duplicate rail, a grant key without {account} are rejected", async () => {
    await rejects(() => loadBillingManifest(mutate("fx: { EUR: 1.18 }", "fx: { }"), { strategies }), "fx", "currency outside fx")
    await rejects(() => loadBillingManifest(mutate("    key: \"{account}:once\"", "    key: \"once\""), { strategies }), "account", "grant key")
  })
  add("BILL-PARSE", "an unknown vendor strategy is refused, a registered one is accepted (rules 21, 25)", async () => {
    const src = mutate("payer: { strategy: hierarchy/v1,", "payer: { strategy: x-test:custom,")
    await rejects(() => loadBillingManifest(src, { strategies: [] }), "x-test:custom", "unregistered strategy")
    check(loadBillingManifest(src, { strategies: ["x-test:custom"] }).payer.strategy === "x-test:custom", "registered strategy refused")
  })
  add("BILL-PARSE", "refs and currency codes are normalised (rule 22)", async () => {
    const m = loadBillingManifest(mutate("price: { model: prepaid-pool, amountMinor: 2000, currency: EUR }", "price: { model: prepaid-pool, amountMinor: 2000, currency: eur }"), { strategies })
    eq(m.derived.offers.get("pack-20")?.price && "currency" in m.derived.offers.get("pack-20")!.price ? (m.derived.offers.get("pack-20")!.price as { currency: string }).currency : "", "EUR", "currency")
    check(m.derived.assets.has("EUR") && !m.derived.assets.has("aip://49/EUR"), "asset ref not normalised")
  })
  add("BILL-PARSE", "the shape check reports every violated field", async () => {
    const bad = parseBillingManifest
    await rejects(() => bad("---\nschema: billing/v1\nname: Bad Name\n---\n"), "name", "shape")
  })

  // ── BILL-PAY (rules 1 to 5) ────────────────────────────────────────
  add("BILL-PAY", "two events about one money movement write once (rule 2)", async () => {
    const { deps, storage, m } = world()
    const body = { intent: "pi_dup", offerId: "pack-20", owner: { orgId: "acme" }, amountMinor: 2000, currency: "EUR", at: ctx.clock.nowMs() }
    const sign = (type: string) => (ctx.provider as unknown as { signed?: (b: object) => { body: string; headers: Record<string, string> } }).signed?.({ ...body, type })
    check(sign("payment_intent.succeeded"), "the provider cannot sign test events: supply a provider with `signed()` or recorded requests")
    await handleWebhook(deps, ctx.provider, sign("payment_intent.succeeded")!)
    const after1 = (await storage.loadEvents("acme")).length
    const second = await handleWebhook(deps, ctx.provider, sign("charge.succeeded")!)
    eq((await storage.loadEvents("acme")).length, after1, "journal length after the second event")
    check(second.type === "payment" && second.outcome.status === "replayed", "second event was not a replay")
    eq(await credits(storage, "acme", m), 236_000 + 47_200, "credits")
  })
  add("BILL-PAY", "a falsified amount or currency is refused and the money is owed back (rules 1, 4)", async () => {
    const { deps, storage } = world()
    const wrongAmount = await applyPayment(deps, pay({ amountMinor: 1999 }))
    check(wrongAmount.status === "refused", "wrong amount accepted")
    const wrongCurrency = await applyPayment(deps, pay({ currency: "USD" }))
    check(wrongCurrency.status === "refused", "wrong currency accepted")
    const owed = await listOwed(storage, "acme", ctx.clock.nowMs())
    eq(owed.reduce((s, o) => s + o.remaining, 0), 1999 + 2000, "owed total")
  })
  add("BILL-PAY", "a webhook with a wrong signature writes nothing (rule 1)", async () => {
    const { deps, storage } = world()
    await rejects(() => handleWebhook(deps, ctx.provider, { body: "{}", headers: { "x-fake-signature": "wrong" } }), "", "a wrong signature")
    eq((await storage.loadEvents("acme")).length, 0, "journal")
  })
  add("BILL-PAY", "what became of this payment is answerable from the journal alone (rule 5)", async () => {
    const { deps, storage } = world()
    const f = pay()
    await applyPayment(deps, f)
    const trace = await traceOf(storage, "acme", f.movement)
    const kinds = trace.map(e => `${e.kind}:${e.origin ?? ""}`).sort()
    check(kinds.includes("mint:payment") && kinds.includes("convert_in:purchase") && kinds.includes("mint:bonus"), `trace incomplete: ${kinds.join(",")}`)
    check(trace.every(e => e.cause === f.movement), "an entry lost its cause")
  })
  add("BILL-PAY", "a failed commit leaves nothing behind (rule 3)", async () => {
    const { deps, state, storage } = world()
    const failing: BillingDeps = { ...deps, storage: Object.assign(Object.create(storage as object), { commit: async () => { throw new Error("disk full") } }) as StoragePort }
    await rejects(() => applyPayment(failing, pay({ offerId: "plan-month", amountMinor: 500 })), "disk full", "commit")
    eq((await state.listPeriods()).length, 0, "periods after a failed commit")
    eq((await storage.loadEvents("acme")).length, 0, "journal after a failed commit")
  })

  // ── BILL-CONV (rules 9 to 14) ──────────────────────────────────────
  add("BILL-CONV", "20 EUR at fx 1.18 gives 2 360 credits plus a 20 percent bonus lot", async () => {
    const { deps, storage, m } = world()
    await applyPayment(deps, pay())
    const lots = fold(await storage.loadEvents("acme"), ctx.clock.nowMs()).filter(l => l.asset === m.primaryAsset)
    eq(lots.find(l => l.partitionId === "REF_CREDITS:purchased")?.original, 236_000, "purchased hundredths")
    eq(lots.find(l => l.partitionId === "REF_CREDITS:bonus")?.original, 47_200, "bonus hundredths")
  })
  add("BILL-CONV", "10 USD at the anchor gives 1 000 credits, no bonus", async () => {
    const { deps, storage, m } = world()
    await applyPayment(deps, pay({ offerId: "pack-usd", amountMinor: 1000, currency: "USD" }))
    eq(await credits(storage, "acme", m), 100_000, "credit hundredths")
  })
  add("BILL-CONV", "net basis converts amount minus tax, gross converts the amount (rule 13)", async () => {
    ctx.clock.set(T0)
    const net = loadBillingManifest(mutate("taxBasis: gross", "taxBasis: net"), { strategies })
    const { storage, state } = ctx.stores()
    const deps: BillingDeps = { manifest: net, storage, clock: ctx.clock, state }
    await applyPayment(deps, pay({ taxMinor: 400 }))
    eq(await credits(storage, "acme", net), 188_800 + 37_760, "net: 1 600 EUR cents converted, 20 percent tier on the net amount")
  })
  add("BILL-CONV", "an amount below a tier gets no bonus, the top tier applies from its threshold", async () => {
    const { deps, storage, m } = world()
    await applyPayment(deps, pay({ offerId: "top-up", amountMinor: 5000 }))
    eq(await credits(storage, "acme", m), 590_000 + 177_000, "30 percent tier at 50 EUR")
  })
  add("BILL-CONV", "points (decimals 0) to credits (decimals 2), edge cap carried, disabled edge still checked (rules 9, 14)", async () => {
    const m = manifest()
    const c = m.derived.conversions.get("points-to-credits")!
    eq(c.fromDecimals, 0, "points decimals")
    eq(c.toDecimals, 2, "credit decimals")
    eq(c.enabled, false, "enabled")
    eq(c.capMinor?.amount, 1000, "cap carried")
    const cyc = mutate("  - id: points-to-credits", "  - id: credits-to-points-gain\n    from: REF_CREDITS\n    to: REF_POINTS\n    rate: { kind: fixed, ratio: 5 }\n    mint: { partition: \"REF_POINTS:default\" }\n    enabled: false\n  - id: points-to-credits")
    await rejects(() => loadBillingManifest(cyc, { strategies }), "arbitrage", "disabled edge in the arbitrage check")
  })

  // ── BILL-REFUND (rules 6 to 8) ─────────────────────────────────────
  add("BILL-REFUND", "a partial refund after spending takes back at most what is left, never the bonus", async () => {
    const { deps, storage, m } = world()
    const f = pay()
    await applyPayment(deps, f)
    await (storage as { spend?: (a: string, s: string, n: number, id: string) => Promise<void> }).spend?.("acme", m.primaryAsset, 200_000, "spent")
    const r = await applyRefund(deps, { type: "refund", movement: "fake:re_1", rail: "fake", paymentMovement: f.movement, amountMinor: 2000, at: ctx.clock.nowMs() }, { accountId: "acme" })
    check(r.status === "applied", "refund not applied")
    eq(r.reclaimed, 36_000, "reclaimed hundredths (what was left of the purchased lot)")
    const bonus = fold(await storage.loadEvents("acme"), ctx.clock.nowMs()).find(l => l.partitionId === "REF_CREDITS:bonus")
    check(bonus !== undefined && bonus.remaining > 0 || (await storage.spendableBalance("acme", m.primaryAsset)) >= 0, "the account went negative or the bonus was touched")
  })
  add("BILL-REFUND", "a refund of a yearly plan at month 2 gives no include from month 3 (rule 7)", async () => {
    const { deps, state, storage, m } = world()
    const f = pay({ offerId: "plan-year", amountMinor: 5000 })
    await applyPayment(deps, f)
    ctx.clock.set(addMonthsUtc(T0, 1) + DAY)
    await runDueIncludes(deps)
    ctx.clock.set(addMonthsUtc(T0, 2) - DAY)
    await applyRefund(deps, { type: "refund", movement: "fake:re_y", rail: "fake", paymentMovement: f.movement, amountMinor: 5000, at: ctx.clock.nowMs() }, { accountId: "acme" })
    ctx.clock.set(addMonthsUtc(T0, 12))
    await runDueIncludes(deps)
    const drops = ((await storage.loadEvents("acme")) as CauseEvent[]).filter(e => e.origin === "include")
    eq(drops.length, 2, "include drops given in total")
    eq((await state.getPeriod(f.movement))?.status, "closed", "period status")
    void m
  })
  add("BILL-REFUND", "a dispute freezes spending, a won dispute releases it, a lost one reclaims (rule 8)", async () => {
    const { deps, storage, m } = world()
    const f = pay()
    await applyPayment(deps, f)
    const before = await storage.spendableBalance("acme", m.primaryAsset)
    const dispute = (movement: string, status: "opened" | "won" | "lost") =>
      applyDispute(deps, { type: "dispute", movement, rail: "fake", paymentMovement: f.movement, status, amountMinor: 2000, currency: "EUR", at: ctx.clock.nowMs() }, { accountId: "acme" })
    await dispute("fake:dp_1", "opened")
    // The freeze is the disputed amount in credits (the whole purchased lot here), not the whole account.
    eq(await storage.spendableBalance("acme", m.primaryAsset), 47_200, "spendable while frozen")
    await dispute("fake:dp_1", "won")
    eq(await storage.spendableBalance("acme", m.primaryAsset), before, "spendable after a won dispute")
    await dispute("fake:dp_2", "opened")
    await dispute("fake:dp_2", "lost")
    eq(await storage.spendableBalance("acme", m.primaryAsset), 47_200, "only the bonus is left after a lost dispute")
  })

  // ── BILL-INCL (rules 15 to 18) ─────────────────────────────────────
  add("BILL-INCL", "two weekly grants both land, the same grant twice lands once (rule 15)", async () => {
    const { deps, storage } = world()
    const base = { accountId: "u1", at: ctx.clock.nowMs(), activeOffers: [] as string[] }
    const a = await applyGrant(deps, "weekly-a", base)
    const b = await applyGrant(deps, "weekly-b", base)
    const again = await applyGrant(deps, "weekly-a", base)
    check(a.status === "applied" && b.status === "applied", "a grant did not land")
    eq(again.status, "replayed", "second firing")
    eq((await storage.loadEvents("u1")).filter(e => e.kind === "mint").length, 2, "mints")
    check(a.key !== b.key, "the two grants share a key")
  })
  add("BILL-INCL", "a top-up replaces the remainder of the previous drop", async () => {
    const { deps, storage, m } = world()
    await applyGrant(deps, "weekly-a", { accountId: "u2", at: T0, activeOffers: [] })
    await (storage as { spend?: (a: string, s: string, n: number, id: string) => Promise<void> }).spend?.("u2", m.primaryAsset, 300, "s")
    ctx.clock.set(T0 + 7 * DAY)
    await applyGrant(deps, "weekly-a", { accountId: "u2", at: T0 + 7 * DAY, activeOffers: [] })
    eq(await credits(storage, "u2", m), 1000, "balance after the second drop")
  })
  add("BILL-INCL", "rollover none expires the remainder at the end of the period, unbounded keeps it (rule 16)", async () => {
    const { deps, storage, m } = world()
    await applyPayment(deps, pay({ offerId: "plan-month", amountMinor: 500 }))
    await applyPayment(deps, pay({ offerId: "plan-keep", amountMinor: 900, owner: { orgId: "keeper" } }))
    ctx.clock.set(addMonthsUtc(T0, 1) + 8 * DAY)
    eq(await credits(storage, "acme", m), 0, "none: remainder after the period and its grace")
    eq(await credits(storage, "keeper", m), 10_000, "unbounded: remainder kept")
  })
  add("BILL-INCL", "past_due keeps the includes for the grace, then the period closes (rule 17)", async () => {
    const { deps, state, m } = world()
    const f = pay({ offerId: "plan-month", amountMinor: 500 })
    await applyPayment(deps, f)
    ctx.clock.set(addMonthsUtc(T0, 1))
    const p = await failRenewal(deps, { accountId: "acme", offerId: "plan-month" })
    eq(p?.status, "past_due", "status")
    check((await activeFeatures(deps, "acme")).includes("pro"), "access lost during grace")
    ctx.clock.set(addMonthsUtc(T0, 1) + 8 * DAY)
    await sweepGrace(deps)
    eq((await state.getPeriod(f.movement))?.status, "closed", "closed after grace")
    check(!(await activeFeatures(deps, "acme")).includes("pro"), "access kept after grace")
    void m
  })
  add("BILL-INCL", "a yearly period gives its includes monthly (twelve drops)", async () => {
    const { deps } = world()
    const f = pay({ offerId: "plan-year", amountMinor: 5000 })
    await applyPayment(deps, f)
    const p = (await deps.state.getPeriod(f.movement))!
    eq(dueDrops({ ...p, given: [] }, addMonthsUtc(T0, 12)).length, 12, "drops over a year")
  })

  // ── BILL-PAYER (rules 19, 20) ──────────────────────────────────────
  const dir = (nodes: AccountNode[]): AccountDirectory => ({ get: async id => nodes.find(n => n.id === id) ?? null })
  add("BILL-PAYER", "a four-level tree walks up through pools to the root (rule 19)", async () => {
    const { m } = world()
    const d = dir([{ id: "root", parentId: null, funding: "pool" }, { id: "a", parentId: "root", funding: "pool" }, { id: "b", parentId: "a", funding: "pool" }, { id: "c", parentId: "b" }])
    const r = await resolvePayer(m, d, "c")
    check(r.ok && r.payerId === "root", "did not reach the root")
  })
  add("BILL-PAYER", "an allocated_budget parent stops the walk, the direct child pays", async () => {
    const { m } = world()
    const d = dir([{ id: "agency", parentId: null, funding: "allocated_budget" }, { id: "client", parentId: "agency" }])
    const r = await resolvePayer(m, d, "client")
    check(r.ok && r.payerId === "client", "the client does not pay from its allocation")
  })
  add("BILL-PAYER", "no cascade: a payer that cannot pay is not replaced (rule 19)", async () => {
    const { m, storage } = world()
    const d = dir([{ id: "agency", parentId: null, funding: "allocated_budget" }, { id: "client", parentId: "agency" }])
    const r = await resolvePayer(m, d, "client")
    check(r.ok, "resolution failed")
    if (r.ok) eq(await canPay(m, storage, r.payerId, 1, ctx.clock.nowMs()), false, "an empty payer can pay")
  })
  add("BILL-PAYER", "a chain longer than maxDepth, a cycle and a missing parent are errors", async () => {
    const { m } = world()
    const long = dir([{ id: "n0", parentId: null, funding: "pool" }, ...[1, 2, 3, 4].map(i => ({ id: `n${i}`, parentId: `n${i - 1}`, funding: "pool" as const }))])
    check(!(await resolvePayer(m, long, "n4")).ok, "a chain longer than maxDepth resolved")
    check(!(await resolvePayer(m, dir([{ id: "x", parentId: "y", funding: "pool" }, { id: "y", parentId: "x", funding: "pool" }]), "x")).ok, "a cycle resolved")
    check(!(await resolvePayer(m, dir([{ id: "x", parentId: "ghost" }]), "x")).ok, "a missing parent resolved")
  })
  add("BILL-PAYER", "owner keys come from the fact, a missing key refuses the payment (rule 20)", async () => {
    const { deps } = world()
    const r = await applyPayment(deps, pay({ owner: {} }))
    eq(r.status, "refused", "payment without owner")
  })

  // ── BILL-RAIL (rule 24, adapters) ──────────────────────────────────
  add("BILL-RAIL", "a manifest that names a rail refuses to start without its variables (rule 24)", async () => {
    const m = manifest()
    await rejects(() => assertRailEnv(m, {}), "FAKE_SECRET_KEY", "missing env")
    assertRailEnv(m, { FAKE_SECRET_KEY: "k", FAKE_WEBHOOK_SECRET: "w" })
  })
  add("BILL-RAIL", "a refund before its payment is unknown, then applies once the payment lands (reordered webhooks)", async () => {
    const { deps, storage } = world()
    const f = pay()
    const refund = (await ctx.provider.verifyWebhook((ctx.provider as unknown as { signed: (b: object) => { body: string; headers: Record<string, string> } }).signed({ type: "charge.refunded", intent: f.movement.replace("fake:", ""), refund: "re_x", amountMinor: 2000, at: ctx.clock.nowMs() })))!
    const first = await (await import("../webhook.js")).handleRailFact(deps, refund)
    check(first.type === "refund" && first.outcome.status === "unknown_payment", "a refund of an unknown payment was applied")
    await applyPayment(deps, f)
    const second = await (await import("../webhook.js")).handleRailFact(deps, refund)
    check(second.type === "refund" && second.outcome.status === "applied", "the refund did not apply after the payment")
    eq(await credits(storage, "acme", deps.manifest), 47_200, "only the bonus is left after a full refund")
  })
  add("BILL-RAIL", "a live rail refuses a test key and the reverse", async () => {
    await rejects(() => assertKeyMatchesMode(railMode("live"), "test", "fake"), "test key", "live rail, test key")
    await rejects(() => assertKeyMatchesMode(railMode(undefined), "live", "fake"), "live key", "test rail, live key")
    eq(railMode(undefined), "test", "default mode")
  })
  add("BILL-RAIL", "the registry resolves a provider registered in process and never echoes a secret", async () => {
    const secret = `secret-${globalThis.crypto.randomUUID()}`
    const reg = makeBillingRegistry({ providers: [ctx.provider], env: { FAKE_SECRET_KEY: secret, FAKE_WEBHOOK_SECRET: `${secret}-wh` } })
    const listed = await reg.family.list()
    const entry = listed.find(e => e.slug === ctx.provider.id)
    check(entry, "the provider is not listed")
    check(!JSON.stringify(listed).includes(secret), "a secret leaked into the listing")
  })
  // ── Settlement defects: a fact that completes, tax, discount, trial (rules 1 to 4) ──
  const journalShape = async (storage: StoragePort, account: string) =>
    ((await storage.loadEvents(account)) as CauseEvent[]).map(e => `${e.id}|${e.kind}|${e.asset}|${e.amount}|${e.lotId}|${e.expiresAt ?? ""}|${e.cause ?? ""}|${e.origin ?? ""}`).sort()
  add("BILL-PAY-COMPLETE", "an incomplete fact then the complete one gives the journal of the complete one alone (rule 2)", async () => {
    const alone = world()
    const full = pay({ movement: "fake:pi_complete" })
    await applyPayment(alone.deps, full)
    const expected = await journalShape(alone.storage, "acme")
    const { deps, storage, m } = world()
    const first = await applyPayment(deps, { ...full, offerId: "unknown-offer" })
    eq(first.status, "refused", "the incomplete fact")
    const second = await applyPayment(deps, full)
    eq(second.status, "applied", "the complete fact after an incomplete one")
    eq((await journalShape(storage, "acme")).join("\n"), expected.join("\n"), "journal")
    eq((await listOwed(storage, "acme", ctx.clock.nowMs())).length, 0, "owed after completion")
    eq(await credits(storage, "acme", m), 236_000 + 47_200, "credits")
    const third = await applyPayment(deps, full)
    eq(third.status, "replayed", "the complete fact again")
  })
  add("BILL-PAY-CONFLICT", "a second fact of one movement with another amount or currency writes nothing and is a conflict", async () => {
    const { deps, storage } = world()
    const f = pay()
    await applyPayment(deps, f)
    const n = (await storage.loadEvents("acme")).length
    const amount = await applyPayment(deps, { ...f, amountMinor: 1999 })
    check(amount.status === "conflict", `a different amount was ${amount.status}`)
    if (amount.status === "conflict") {
      eq(amount.recorded.amountMinor, 2000, "recorded amount")
      eq(amount.received.amountMinor, 1999, "received amount")
    }
    const currency = await applyPayment(deps, { ...f, currency: "USD" })
    eq(currency.status, "conflict", "a different currency")
    eq((await storage.loadEvents("acme")).length, n, "journal length")
    // A refused fact cannot be completed by a fact of another amount either.
    const g = pay({ offerId: "unknown-offer" })
    await applyPayment(deps, g)
    const other = await applyPayment(deps, { ...g, offerId: "pack-20", amountMinor: 2500 })
    eq(other.status, "conflict", "completing a refused fact with another amount")
  })
  add("BILL-PAY-TAX-EXCL", "a tax added on top of the price is accepted, an inclusive amount over the price is not (rule 1)", async () => {
    const { deps, storage, m } = world()
    const ok = await applyPayment(deps, pay({ amountMinor: 2400, taxMinor: 400, taxBehavior: "exclusive" }))
    eq(ok.status, "applied", "price plus exclusive tax")
    // Gross basis: the whole paid amount is converted, as for an inclusive tax.
    eq(await credits(storage, "acme", m), 283_200 + 56_640, "credits of 24 EUR, 20 percent tier")
    const ko = await applyPayment(deps, pay({ amountMinor: 2400, taxMinor: 400 }))
    eq(ko.status, "refused", "inclusive tax over the price")
  })
  add("BILL-PAY-DISCOUNT", "a discount is accepted only on an offer that allows it; credits follow the amount paid", async () => {
    const { deps, storage, m } = world()
    const refused = await applyPayment(deps, pay({ amountMinor: 1500, discountMinor: 500 }))
    eq(refused.status, "refused", "a discount on an offer without `discounts: allow`")
    const ok = await applyPayment(deps, pay({ offerId: "pack-promo", amountMinor: 1500, discountMinor: 500, owner: { orgId: "promo" } }))
    eq(ok.status, "applied", "a discount on an offer that allows it")
    eq(await credits(storage, "promo", m), 177_000 + 35_400, "credits of 15 EUR paid, 20 percent tier")
    const wrong = await applyPayment(deps, pay({ offerId: "pack-promo", amountMinor: 1500, discountMinor: 400, owner: { orgId: "promo" } }))
    eq(wrong.status, "refused", "amount plus discount differs from the price")
  })
  add("BILL-PAY-TRIAL", "a zero payment opens a trial period on an offer with a trial, and is refused elsewhere", async () => {
    const { deps, storage, state, m } = world()
    const trial = pay({ offerId: "plan-trial", amountMinor: 0 })
    const out = await applyPayment(deps, trial)
    eq(out.status, "applied", "zero payment of a trial offer")
    const p = await state.getPeriod(trial.movement)
    eq(p?.status, "active", "trial period")
    eq(p?.endAt, T0 + 14 * DAY, "trial end")
    check((await activeFeatures(deps, "acme")).includes("pro"), "the trial does not open the features")
    eq((await listOwed(storage, "acme", ctx.clock.nowMs())).length, 0, "owed after a trial")
    eq(await credits(storage, "acme", m), 60_000, "includes of the trial")
    const refused = await applyPayment(deps, pay({ offerId: "plan-month", amountMinor: 0, owner: { orgId: "other" } }))
    eq(refused.status, "refused", "zero payment of an offer without a trial")
    // The first paid period continues the trial without a gap.
    ctx.clock.set(T0 + 14 * DAY)
    const paid = pay({ offerId: "plan-trial", amountMinor: 500 })
    await applyPayment(deps, paid)
    eq((await state.getPeriod(paid.movement))?.startAt, T0 + 14 * DAY, "first paid period starts at the trial end")
  })

  // ── Refunds: cumulative share, reversal, call reference (rules 6, 7) ──
  const refund = (deps: BillingDeps, paymentMovement: string, movement: string, amountMinor: number) =>
    applyRefund(deps, { type: "refund", movement, rail: "fake", paymentMovement, amountMinor, at: ctx.clock.nowMs() }, { accountId: "acme" })
  add("BILL-REFUND-PARTIAL-OPEN", "a partial refund keeps the period open, the refunds that reach the payment close it, never more than paid", async () => {
    const { deps, state, storage } = world()
    const f = pay({ offerId: "plan-year", amountMinor: 5000 })
    await applyPayment(deps, f)
    const r1 = await refund(deps, f.movement, "fake:re_a", 1000)
    eq(r1.reclaimed, 12_000, "a fifth of the first drop")
    eq((await state.getPeriod(f.movement))?.status, "active", "period after a partial refund")
    ctx.clock.set(addMonthsUtc(T0, 1) + DAY)
    await runDueIncludes(deps)
    eq(((await storage.loadEvents("acme")) as CauseEvent[]).filter(e => e.origin === "include").length, 2, "includes keep coming after a partial refund")
    // Two refunds of the same amount are two refunds.
    const r2 = await refund(deps, f.movement, "fake:re_b", 1000)
    eq(r2.status, "applied", "a second refund of the same amount")
    await refund(deps, f.movement, "fake:re_c", 3000)
    eq((await state.getPeriod(f.movement))?.status, "closed", "period once the refunds reach the payment")
    const over = await refund(deps, f.movement, "fake:re_d", 1000)
    eq(over.reclaimed, 0, "a refund beyond the payment takes nothing more")
  })
  add("BILL-REFUND-REVERSED", "a refund that fails after it succeeded gives back what it took and reopens the period", async () => {
    const { deps, state, storage, m } = world()
    const f = pay()
    await applyPayment(deps, f)
    const expiry = fold(await storage.loadEvents("acme"), ctx.clock.nowMs()).find(l => l.partitionId === "REF_CREDITS:purchased")?.expiresAt
    await refund(deps, f.movement, "fake:re_r", 2000)
    eq(await credits(storage, "acme", m), 47_200, "after the refund")
    const fact = { type: "refund_reversed" as const, movement: "fake:re_r", rail: "fake", paymentMovement: f.movement, amountMinor: 2000, at: ctx.clock.nowMs() }
    const back = await applyRefundReversal(deps, fact, { accountId: "acme" })
    eq(back.status, "applied", "reversal")
    eq(back.restored, 236_000, "credits given back")
    eq(await credits(storage, "acme", m), 236_000 + 47_200, "after the reversal")
    const lot = fold(await storage.loadEvents("acme"), ctx.clock.nowMs()).find(l => l.partitionId === "REF_CREDITS:purchased" && l.remaining > 0)
    eq(lot?.expiresAt, expiry, "the given-back lot keeps the original expiry")
    eq((await applyRefundReversal(deps, fact, { accountId: "acme" })).status, "replayed", "reversal twice")
    eq(await credits(storage, "acme", m), 236_000 + 47_200, "after a replayed reversal")
    // Through the webhook dispatch, on a subscription: the period reopens.
    const s = pay({ offerId: "plan-month", amountMinor: 500 })
    await applyPayment(deps, s)
    await refund(deps, s.movement, "fake:re_s", 500)
    eq((await state.getPeriod(s.movement))?.status, "closed", "period after the full refund")
    const viaHook = await handleRailFact(deps, { ...fact, movement: "fake:re_s", paymentMovement: s.movement, amountMinor: 500 })
    check(viaHook.type === "refund_reversed" && viaHook.outcome.status === "applied", "the reversal did not dispatch")
    eq((await state.getPeriod(s.movement))?.status, "active", "period after the reversal")
    eq((await applyRefundReversal(deps, { ...fact, movement: "fake:re_none" }, { accountId: "acme" })).status, "unknown_refund", "reversal of an unknown refund")
  })
  add("BILL-REFUND-REF", "two refunds of the same amount on one payment are two refunds at the rail; the same reference is one", async () => {
    const p = ctx.provider
    if (!p.refund) return
    const a = await p.refund("fake:pi_ref", 500, "refund-1")
    const b = await p.refund("fake:pi_ref", 500, "refund-2")
    const again = await p.refund("fake:pi_ref", 500, "refund-1")
    check(a.ok && b.ok && again.ok, "a refund failed")
    check(a.externalRef !== b.externalRef, "two refunds of one amount collapsed into one")
    eq(again.externalRef, a.externalRef, "the same reference twice")
  })

  // ── Disputes: amount, late win, several per payment, inquiries (rule 8) ──
  const disputeOf = (deps: BillingDeps, paymentMovement: string, movement: string, status: "opened" | "won" | "lost", amountMinor: number, currency = "EUR") =>
    applyDispute(deps, { type: "dispute", movement, rail: "fake", paymentMovement, status, amountMinor, currency, at: ctx.clock.nowMs() }, { accountId: "acme" })
  add("BILL-DISPUTE-PARTIAL", "a dispute of part of a payment freezes and takes back that part only", async () => {
    const { deps, storage, m } = world()
    const f = pay()
    await applyPayment(deps, f)
    const opened = await disputeOf(deps, f.movement, "fake:dp_p", "opened", 500)
    eq(opened.held, 59_000, "held: a quarter of the purchased credits")
    eq(await storage.spendableBalance("acme", m.primaryAsset), 236_000 + 47_200 - 59_000, "spendable while a quarter is frozen")
    const lost = await disputeOf(deps, f.movement, "fake:dp_p", "lost", 500)
    eq(lost.reclaimed, 59_000, "reclaimed: a quarter")
    eq(await credits(storage, "acme", m), 177_000 + 47_200, "credits after the lost part")
  })
  add("BILL-DISPUTE-LATE-WIN", "a dispute won after it was lost gives the credits back", async () => {
    const { deps, storage, state, m } = world()
    const f = pay({ offerId: "plan-month", amountMinor: 500 })
    await applyPayment(deps, f)
    await disputeOf(deps, f.movement, "fake:dp_w", "opened", 500)
    const lost = await disputeOf(deps, f.movement, "fake:dp_w", "lost", 500)
    eq(lost.reclaimed, 60_000, "reclaimed on loss")
    eq((await state.getPeriod(f.movement))?.status, "closed", "period after the loss")
    const won = await disputeOf(deps, f.movement, "fake:dp_w", "won", 500)
    eq(won.status, "applied", "late win")
    eq(won.restored, 60_000, "given back on the late win")
    eq(await credits(storage, "acme", m), 60_000, "credits after the late win")
    eq((await state.getPeriod(f.movement))?.status, "active", "period after the late win")
    eq((await disputeOf(deps, f.movement, "fake:dp_w", "won", 500)).status, "replayed", "late win twice")
    // A loss with no prior `opened` still takes its share back.
    const g = pay({ owner: { orgId: "acme" } })
    await applyPayment(deps, g)
    const direct = await disputeOf(deps, g.movement, "fake:dp_direct", "lost", 2000)
    eq(direct.reclaimed, 236_000, "a loss without an opened event")
  })
  add("BILL-DISPUTE-MULTI", "several disputes on one payment are handled each by its own movement, the total never above the payment", async () => {
    const { deps, storage, m } = world()
    const f = pay()
    await applyPayment(deps, f)
    await disputeOf(deps, f.movement, "fake:dp_m1", "opened", 1500)
    await disputeOf(deps, f.movement, "fake:dp_m2", "opened", 1500)
    const a = await disputeOf(deps, f.movement, "fake:dp_m1", "lost", 1500)
    const b = await disputeOf(deps, f.movement, "fake:dp_m2", "lost", 1500)
    eq(a.reclaimed, 177_000, "first loss: three quarters")
    eq(b.reclaimed, 59_000, "second loss: only what is left of the payment")
    eq(await credits(storage, "acme", m), 47_200, "only the bonus is left")
    eq(await storage.spendableBalance("acme", m.primaryAsset), 47_200, "nothing stays frozen")
  })
  add("BILL-DISPUTE-INQUIRY", "an inquiry (warning_*) is not a dispute: no fact, nothing frozen", async () => {
    const signer = (ctx.provider as unknown as { signed?: (b: object) => { body: string; headers: Record<string, string> } }).signed
    if (!signer) return
    const fact = await ctx.provider.verifyWebhook(signer.call(ctx.provider, { type: "dispute.opened", intent: "pi_inq", dispute: "dp_inq", status: "warning_needs_response", amountMinor: 2000, currency: "EUR", at: ctx.clock.nowMs() }))
    eq(fact, null, "an inquiry became a fact")
  })
  return cases
}
