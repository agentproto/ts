/**
 * Contract cases for a payment provider package (SET-*). A provider package
 * runs them in its CI against its own `SettlementProvider`, with the kit's
 * in-memory stores or the host's, and a factory of SIGNED requests in its own
 * rail vocabulary (`events`): recorded or built from the rail's public
 * reference, signed in the test.
 *
 *   import { settlementProviderContractCases } from "@agentproto/billing/contract-tests"
 *   for (const c of settlementProviderContractCases({ provider, stores, clock, events, ... })) it(c.name, c.run)
 *
 * No silent skip: a case whose scenario is missing FAILS, unless its id is
 * listed in `unsupported` and the matching capability of the provider is
 * false. Such a case still runs, and checks that the capability is false.
 */
import { fold } from "@agentproto/wallet"
import type { StoragePort } from "@agentproto/wallet/ports"
import { assertRailCapabilities } from "../capabilities.js"
import type { BillingHandle } from "../define-billing-manifest.js"
import { loadBillingManifest } from "../manifest/index.js"
import { listOwed } from "../payment.js"
import type { BillingDeps, BillingStateStore, CauseEvent } from "../ports.js"
import { makeBillingRegistry } from "../registry.js"
import type { RailFact, SettlementCapabilities, SettlementProvider, WebhookRequest } from "../settlement.js"
import type { ConformanceCase } from "../testing/conformance.js"
import type { ManualClock } from "../testing/fakes.js"
import { REFERENCE_MANIFEST } from "../testing/reference-manifest.js"
import { handleWebhook, type FactOutcome } from "../webhook.js"

type Req = WebhookRequest | Promise<WebhookRequest>

/** A payment as the rail would report it. `ref` is a token unique to the scenario: build the rail ids from it. */
export interface PaymentScenario {
  ref: string
  offerId: string
  owner: Record<string, string>
  amountMinor: number
  currency: string
  at: number
}

/** A fact about an earlier payment. `paymentMovement` is the movement the provider gave that payment. */
export interface MoneyScenario {
  ref: string
  paymentMovement: string
  amountMinor: number
  at: number
}

/**
 * Signed requests in the provider's own vocabulary, one builder per scenario.
 * Each is optional only so that a missing one can be reported: see
 * `unsupported`.
 */
export interface SettlementEvents {
  /** A completed payment of an offer: `verifyWebhook` turns it into a `PaymentFact`. */
  payment?(s: PaymentScenario): Req
  /** An event about the same money movement that lacks what ties it to the offer (a `PaymentFact` the core refuses, or null). */
  paymentIncomplete?(s: PaymentScenario): Req
  /** The completion of the checkout `checkoutRef` returned by `createCheckout`. */
  checkoutCompleted?(s: { checkoutRef: string; amountMinor: number; currency: string; at: number }): Req
  /** A refund that succeeded. */
  refund?(s: MoneyScenario): Req
  /** A refund that is still pending: no fact. */
  refundPending?(s: MoneyScenario): Req
  /** The refund `ref` (a succeeded one) failed or was canceled. */
  refundFailed?(s: MoneyScenario): Req
  /** A dispute `ref` at a status. */
  dispute?(s: MoneyScenario & { status: "opened" | "won" | "lost"; currency: string }): Req
  /** An inquiry that moves no money (a warning before a dispute): no fact. */
  inquiry?(s: MoneyScenario & { currency: string }): Req
  renewalFailed?(s: { ref: string; offerId: string; owner: Record<string, string>; at: number }): Req
  subscriptionEnded?(s: { ref: string; offerId: string; owner: Record<string, string>; reason: "canceled" | "unpaid"; at: number }): Req
  /** An event about no money at all. */
  noMoney?(s: { ref: string; at: number }): Req
  /** A request whose signature is wrong. */
  badSignature?(s: { ref: string; at: number }): Req
  /** A payment event of the other mode (a test event on a live rail, or the reverse). */
  wrongMode?(s: PaymentScenario): Req
}

export interface SettlementContractContext {
  provider: SettlementProvider
  /** Fresh, empty stores for one case. */
  stores: () => { storage: StoragePort; state: BillingStateStore }
  clock: ManualClock
  /** The reference manifest with the provider's rail id (default: the reference manifest, rail `fake`). */
  manifestSource?: string
  events: SettlementEvents
  /** Case ids (`SET-10`, ...) this provider does not serve. Accepted only when the matching capability is false. */
  unsupported?: readonly string[]
  /** Credential values the provider was built with: SET-8 checks that none leaks. */
  secrets?: readonly string[]
  /** SET-10: a return URL the provider accepts and one it must refuse. */
  returnUrls?: { allowed: string; refused: string }
  /** SET-9: a provider of the same rail built with a key of the other mode. */
  misconfigured?: () => SettlementProvider
  /** SET-10, SET-11: how many WRITE calls the provider has made to its rail so far. */
  railWrites?: () => number
}

class ContractError extends Error {}
const check = (cond: unknown, msg: string): void => {
  if (!cond) throw new ContractError(msg)
}
const eq = (a: unknown, b: unknown, msg: string): void => check(Object.is(a, b), `${msg}: expected ${String(b)}, got ${String(a)}`)
const throwsAsync = async (fn: () => unknown, msg: string): Promise<Error> => {
  try {
    await fn()
  } catch (e) {
    return e as Error
  }
  throw new ContractError(`${msg}: did not throw`)
}

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0)

type CapabilityCheck = (c: SettlementCapabilities) => boolean
interface Requirement {
  events?: (keyof SettlementEvents)[]
  ctx?: ("secrets" | "returnUrls" | "misconfigured" | "railWrites")[]
  /** True when the capability that makes the case apply is ON. Absent: the case applies to every provider. */
  applies?: CapabilityCheck
  /** The capability named in the error, for a case declared unsupported while its capability is on. */
  capability?: string
}

export function settlementProviderContractCases(ctx: SettlementContractContext): ConformanceCase[] {
  const p = ctx.provider
  const source = ctx.manifestSource ?? REFERENCE_MANIFEST
  const manifest = (): BillingHandle => loadBillingManifest(source, { strategies: [] })
  const world = () => {
    ctx.clock.set(T0)
    const { storage, state } = ctx.stores()
    const m = manifest()
    const deps: BillingDeps = { manifest: m, storage, clock: ctx.clock, state }
    return { m, deps, storage, state }
  }
  let n = 0
  const ref = () => `set${++n}x${Math.random().toString(36).slice(2, 8)}`
  const ev = ctx.events
  const credits = async (storage: StoragePort, account: string, m: BillingHandle) => {
    const now = ctx.clock.nowMs()
    return fold(await storage.loadEvents(account), now)
      .filter(l => l.asset === m.primaryAsset && !(l.expiresAt !== undefined && l.expiresAt <= now))
      .reduce((s, l) => s + l.remaining - l.reserved, 0)
  }
  const journal = async (storage: StoragePort, account: string) => (await storage.loadEvents(account)).length
  const factOf = async (req: Req): Promise<RailFact | null> => p.verifyWebhook(await req)
  const movementOf = async (req: Req): Promise<string> => {
    const f = await factOf(req)
    check(f && f.type === "payment", "the payment scenario did not verify into a payment fact")
    return f!.movement
  }
  const deliver = async (deps: BillingDeps, req: Req): Promise<FactOutcome> => handleWebhook(deps, p, await req)
  const statusOf = (o: FactOutcome): string => ("outcome" in o ? (o.outcome as { status: string }).status : o.type)
  const paymentOf = (over: Partial<PaymentScenario> = {}): PaymentScenario => ({
    ref: ref(),
    offerId: "pack-20",
    owner: { orgId: "acme" },
    amountMinor: 2000,
    currency: "EUR",
    at: ctx.clock.nowMs(),
    ...over,
  })

  const cases: ConformanceCase[] = []
  const add = (id: string, name: string, need: Requirement, run: () => Promise<void>) => {
    const declared = ctx.unsupported?.includes(id) ?? false
    const missing = [
      ...(need.events ?? []).filter(e => typeof ev[e] !== "function").map(e => `events.${e}`),
      ...(need.ctx ?? []).filter(k => ctx[k] === undefined || (k === "secrets" && (ctx.secrets?.length ?? 0) === 0)),
    ]
    if (declared) {
      cases.push({
        name: `${id} ${name} (declared unsupported)`,
        run: async () => {
          check(need.applies !== undefined, `${id} cannot be declared unsupported: every provider must pass it`)
          check(!need.applies!(p.capabilities), `${id} is declared unsupported but capability '${need.capability}' is on`)
        },
      })
      return
    }
    cases.push({
      name: `${id} ${name}`,
      run: async () => {
        if (need.applies && !need.applies(p.capabilities)) {
          throw new ContractError(`${id}: capability '${need.capability}' is off; list '${id}' in \`unsupported\` to say so`)
        }
        check(missing.length === 0, `${id}: the context lacks ${missing.join(", ")}; provide it, or list '${id}' in \`unsupported\` with its capability off`)
        await run()
      },
    })
  }

  // ── SET-1 signature ──
  add("SET-1", "a wrong or tampered signature throws and writes nothing", { events: ["badSignature", "payment"] }, async () => {
    const w = world()
    await throwsAsync(async () => deliver(w.deps, ev.badSignature!({ ref: ref(), at: ctx.clock.nowMs() })), "a wrong signature")
    const good = await ev.payment!(paymentOf())
    await throwsAsync(() => handleWebhook(w.deps, p, { ...good, body: `${good.body} ` }), "a tampered body")
    await throwsAsync(() => handleWebhook(w.deps, p, { ...good, headers: {} }), "a request without signature")
    eq(await journal(w.storage, "acme"), 0, "journal after rejected requests")
  })

  // ── SET-2 no money ──
  add("SET-2", "an event about no money gives no fact and writes nothing", { events: ["noMoney"] }, async () => {
    const w = world()
    const out = await deliver(w.deps, ev.noMoney!({ ref: ref(), at: ctx.clock.nowMs() }))
    eq(out.type, "ignored", "outcome")
    eq(await journal(w.storage, "acme"), 0, "journal")
  })

  // ── SET-3 duplicate ──
  add("SET-3", "the same source event twice writes once", { events: ["payment"] }, async () => {
    const w = world()
    const req = await ev.payment!(paymentOf())
    const first = await deliver(w.deps, req)
    eq(statusOf(first), "applied", "first delivery")
    const len = await journal(w.storage, "acme")
    const second = await deliver(w.deps, req)
    eq(statusOf(second), "replayed", "second delivery")
    eq(await journal(w.storage, "acme"), len, "journal after the duplicate")
  })

  // ── SET-5 reversed order ──
  add("SET-5", "a refund before its payment is kept or unknown, then applied once the payment lands", { events: ["payment", "refund"], applies: c => c.refunds !== "none" || c.moneyFacts === "self", capability: "refunds" }, async () => {
    const w = world()
    const pay = paymentOf({ offerId: "plan-month", amountMinor: 500 })
    const payReq = await ev.payment!(pay)
    const pm = await movementOf(payReq)
    const refundReq = await ev.refund!({ ref: ref(), paymentMovement: pm, amountMinor: 500, at: ctx.clock.nowMs() })
    const early = await deliver(w.deps, refundReq)
    const deferring = typeof w.state.deferFact === "function" && typeof w.state.takeDeferred === "function"
    eq(statusOf(early), deferring ? "deferred" : "unknown_payment", "a refund before its payment")
    eq(await journal(w.storage, "acme"), 0, "journal before the payment")
    await deliver(w.deps, payReq)
    if (!deferring) {
      // The host keeps and replays the fact itself.
      eq(statusOf(await deliver(w.deps, refundReq)), "applied", "the refund replayed after its payment")
    } else {
      eq(statusOf(await deliver(w.deps, refundReq)), "replayed", "the refund delivered again after it was applied")
    }
    eq(await credits(w.storage, "acme", w.m), 0, "credits after the refund")
    eq((await w.state.getPeriod(pm))?.status, "closed", "period after the full refund")
  })
  add("SET-5-SUB", "a renewal failure or an end before the period is a no-op, then applies once the period exists", { events: ["payment", "renewalFailed", "subscriptionEnded"], applies: c => c.subscriptions, capability: "subscriptions" }, async () => {
    const w = world()
    const owner = { orgId: "acme" }
    const failed = await ev.renewalFailed!({ ref: ref(), offerId: "plan-month", owner, at: ctx.clock.nowMs() })
    eq(statusOf(await deliver(w.deps, failed)), "no_period", "a renewal failure before any period")
    const ended = await ev.subscriptionEnded!({ ref: ref(), offerId: "plan-month", owner, reason: "canceled", at: ctx.clock.nowMs() })
    eq(statusOf(await deliver(w.deps, ended)), "no_period", "an end before any period")
    eq(await journal(w.storage, "acme"), 0, "journal")
    const payReq = await ev.payment!(paymentOf({ offerId: "plan-month", amountMinor: 500 }))
    const pm = await movementOf(payReq)
    await deliver(w.deps, payReq)
    eq(statusOf(await deliver(w.deps, failed)), "applied", "the renewal failure once the period exists")
    eq((await w.state.getPeriod(pm))?.status, "past_due", "period after the renewal failure")
    eq(statusOf(await deliver(w.deps, failed)), "replayed", "the renewal failure twice")
    eq(statusOf(await deliver(w.deps, ended)), "applied", "the end once the period exists")
    const closed = await w.state.getPeriod(pm)
    eq(closed?.status, "closed", "period after the end")
    eq(closed?.closedReason, "canceled", "closed reason")
  })

  // ── SET-6 honest capabilities ──
  add("SET-6", "capabilities are honest: a method is present exactly when its capability is on", {}, async () => {
    const c = p.capabilities
    check(c && typeof c === "object", "the provider has no capabilities")
    eq(typeof p.refund === "function", c.refunds !== "none", "refund() present <=> refunds is not 'none'")
    eq(typeof p.createCheckout === "function", c.checkout, "createCheckout() present <=> checkout")
    eq(typeof p.createPortalSession === "function", c.portal, "createPortalSession() present <=> portal")
    eq(typeof p.syncCatalog === "function", c.catalogSync, "syncCatalog() present <=> catalogSync")
    if (c.moneyFacts === "delegated") check(typeof c.moneyFactsFrom === "string" && c.moneyFactsFrom !== "", "moneyFacts 'delegated' names moneyFactsFrom")
    if (!c.offSessionCharge) {
      const r = await p.charge({ accountId: "acme", amountMinor: 100, asset: "EUR", ref: ref() })
      check(!r.ok, "charge() succeeds while offSessionCharge is off")
    }
    if (!c.payouts) {
      const r = await p.pay({ counterparty: "acme", amountMinor: 100, asset: "EUR" })
      check(!r.ok, "pay() succeeds while payouts is off")
    }
  })

  // ── SET-7 offers the rail does not serve ──
  add("SET-7", "an offer the rail does not serve refuses to start, naming offer, rail and flag", {}, async () => {
    const m = manifest()
    const rail = m.rails.find(r => (r.provider ?? r.id) === p.id)
    check(rail, `the manifest declares no rail served by '${p.id}'`)
    const flags = Object.entries(p.capabilities).filter(([, v]) => v === false).map(([k]) => k)
    try {
      assertRailCapabilities(m, [p])
    } catch (e) {
      const msg = (e as Error).message
      check(flags.some(f => msg.includes(f)) || msg.includes("refund"), `refused for a flag the provider does not lack: '${msg}'`)
    }
    const cut = Object.assign(Object.create(p as object) as SettlementProvider, { capabilities: { ...p.capabilities, subscriptions: false } })
    const err = await throwsAsync(() => assertRailCapabilities(m, [cut]), "a subscription offer on a rail without subscriptions")
    for (const part of ["plan-month", `'${rail!.id}'`, "subscriptions"]) check(err.message.includes(part), `the refusal names ${part}: '${err.message}'`)
  })

  // ── SET-8 secrets ──
  add("SET-8", "no secret in errors, String(), JSON.stringify or the registry listing", { events: ["badSignature"], ctx: ["secrets"] }, async () => {
    const secrets = ctx.secrets!
    const leaks = (text: string) => secrets.filter(s => s.length > 0 && text.includes(s))
    const texts: [string, string][] = [
      ["JSON.stringify(provider)", JSON.stringify(p)],
      ["String(provider)", String(p)],
    ]
    const bad = await throwsAsync(async () => p.verifyWebhook(await ev.badSignature!({ ref: ref(), at: ctx.clock.nowMs() })), "a wrong signature")
    texts.push(["the signature error", `${bad.message} ${bad.stack ?? ""}`])
    if (ev.wrongMode) {
      const e = await throwsAsync(async () => p.verifyWebhook(await ev.wrongMode!(paymentOf())), "an event of the other mode")
      texts.push(["the mode error", `${e.message} ${e.stack ?? ""}`])
    }
    if (p.check) texts.push(["check()", JSON.stringify(await p.check())])
    const reg = makeBillingRegistry({ providers: [p], env: { [p.env.secretKey]: secrets[0], [p.env.webhookSecret]: secrets[secrets.length - 1] } })
    texts.push(["the registry listing", JSON.stringify(await reg.family.list())])
    for (const [where, text] of texts) {
      const found = leaks(text)
      check(found.length === 0, `a secret leaked into ${where}`)
    }
  })

  // ── SET-9 mode ──
  add("SET-9", "an event of the other mode throws and writes nothing; a key of the other mode fails check()", { events: ["wrongMode"], ctx: ["misconfigured"] }, async () => {
    const w = world()
    await throwsAsync(async () => deliver(w.deps, ev.wrongMode!(paymentOf())), "an event of the other mode")
    eq(await journal(w.storage, "acme"), 0, "journal")
    const other = ctx.misconfigured!()
    check(typeof other.check === "function", "the provider has no check(): a key of the wrong mode cannot be caught at start-up")
    const r = await other.check!()
    check(!r.ok, "check() passes with a key of the other mode")
    check(typeof r.reason === "string" && r.reason.length > 0, "check() fails without a reason")
  })

  // ── SET-10 return URLs ──
  add("SET-10", "a return URL outside the list is refused before any call; no checkout outcome writes", { ctx: ["returnUrls", "railWrites"], applies: c => c.checkout, capability: "checkout" }, async () => {
    const w = world()
    const urls = ctx.returnUrls!
    const req = (successUrl: string, cancelUrl: string) => ({ offerId: "pack-20", owner: { orgId: "acme" }, accountId: "acme", successUrl, cancelUrl })
    const writes = ctx.railWrites!()
    await throwsAsync(() => p.createCheckout!(req(urls.refused, urls.allowed)), "a success URL outside the list")
    await throwsAsync(() => p.createCheckout!(req(urls.allowed, urls.refused)), "a cancel URL outside the list")
    eq(ctx.railWrites!(), writes, "rail writes after refused return URLs")
    if (p.capabilities.portal) {
      await throwsAsync(() => p.createPortalSession!({ owner: { orgId: "acme" }, accountId: "acme", returnUrl: urls.refused }), "a portal return URL outside the list")
      eq(ctx.railWrites!(), writes, "rail writes after a refused portal URL")
    }
    const out = await p.createCheckout!(req(urls.allowed, urls.allowed))
    check(["redirect", "charged", "invoice_sent", "no_payment"].includes(out.outcome), `unknown checkout outcome '${out.outcome}'`)
    check(typeof out.ref === "string" && out.ref !== "", "the outcome has no ref")
    if (out.outcome === "redirect") check(typeof out.url === "string" && out.url.length > 0, "a redirect without url")
    eq(await journal(w.storage, "acme"), 0, "journal after a checkout: only the verified webhook writes")
  })

  // ── SET-11 catalog ──
  add("SET-11", "syncCatalog twice creates nothing the second time; a dry run writes nothing; degradations are listed", { ctx: ["railWrites"], applies: c => c.catalogSync, capability: "catalogSync" }, async () => {
    const m = manifest()
    const before = ctx.railWrites!()
    const dry = await p.syncCatalog!(m, { dryRun: true })
    eq(ctx.railWrites!(), before, "rail writes of a dry run")
    for (const k of ["created", "updated", "unchanged", "degradations"] as const) check(Array.isArray(dry[k]), `the report has no '${k}' list`)
    const first = await p.syncCatalog!(m)
    const second = await p.syncCatalog!(m)
    eq(second.created.length, 0, "created by the second sync")
    eq(second.updated.length, 0, "updated by the second sync")
    check(first.created.length + first.unchanged.length + first.updated.length > 0, "the first sync reports nothing at all")
    for (const d of second.degradations) {
      check(m.derived.offers.has(d.offerId), `a degradation names an unknown offer '${d.offerId}'`)
      check(typeof d.field === "string" && d.field !== "" && typeof d.reason === "string" && d.reason !== "", "a degradation without field or reason")
    }
  })

  // ── SET-12 owner keys of a checkout ──
  add("SET-12", "the owner keys of a checkout come back in its payment fact; a missing key is refused", { events: ["checkoutCompleted"], ctx: ["returnUrls"], applies: c => c.checkout, capability: "checkout" }, async () => {
    const w = world()
    const urls = ctx.returnUrls!
    await throwsAsync(() => p.createCheckout!({ offerId: "pack-20", owner: {}, accountId: "acme", successUrl: urls.allowed, cancelUrl: urls.allowed }), "a checkout without the owner keys")
    const out = await p.createCheckout!({ offerId: "pack-20", owner: { orgId: "acme" }, accountId: "acme", successUrl: urls.allowed, cancelUrl: urls.allowed })
    const req = ev.checkoutCompleted!({ checkoutRef: out.ref, amountMinor: 2000, currency: "EUR", at: ctx.clock.nowMs() })
    const fact = await factOf(req)
    check(fact && fact.type === "payment", "the completed checkout gives no payment fact")
    if (fact?.type === "payment") {
      eq(fact.offerId, "pack-20", "offer of the fact")
      eq(fact.owner.orgId, "acme", "owner key of the fact")
    }
    eq(statusOf(await deliver(w.deps, req)), "applied", "the completed checkout")
  })

  // ── SET-13 incomplete then complete ──
  add("SET-13", "an incomplete event then the complete one give the journal of the reverse order", { events: ["payment", "paymentIncomplete"] }, async () => {
    const shape = async (storage: StoragePort) =>
      ((await storage.loadEvents("acme")) as CauseEvent[]).map(e => `${e.id}|${e.kind}|${e.asset}|${e.amount}|${e.lotId}|${e.cause ?? ""}|${e.origin ?? ""}`).sort().join("\n")
    const s = paymentOf()
    const a = world()
    await deliver(a.deps, ev.payment!(s))
    await deliver(a.deps, ev.paymentIncomplete!(s))
    const forward = await shape(a.storage)
    const b = world()
    await deliver(b.deps, ev.paymentIncomplete!(s))
    await deliver(b.deps, ev.payment!(s))
    eq(await shape(b.storage), forward, "journal, incomplete first")
    eq((await listOwed(b.storage, "acme", ctx.clock.nowMs())).length, 0, "owed once the complete event landed")
    eq(await credits(b.storage, "acme", b.m), await credits(a.storage, "acme", a.m), "credits")
  })

  // ── SET-21 refund lifecycle ──
  add("SET-21", "a pending refund gives no fact; a succeeded one takes back once; its failure gives back once", { events: ["payment", "refund", "refundPending", "refundFailed"], applies: c => c.refundReversals, capability: "refundReversals" }, async () => {
    const w = world()
    const payReq = await ev.payment!(paymentOf())
    const pm = await movementOf(payReq)
    await deliver(w.deps, payReq)
    const full = await credits(w.storage, "acme", w.m)
    const r = { ref: ref(), paymentMovement: pm, amountMinor: 1000, at: ctx.clock.nowMs() }
    eq((await deliver(w.deps, ev.refundPending!(r))).type, "ignored", "a pending refund")
    eq(await credits(w.storage, "acme", w.m), full, "credits after a pending refund")
    const ok = await ev.refund!(r)
    eq(statusOf(await deliver(w.deps, ok)), "applied", "the succeeded refund")
    eq(statusOf(await deliver(w.deps, ok)), "replayed", "the succeeded refund twice")
    const after = await credits(w.storage, "acme", w.m)
    check(after < full, "the refund took nothing back")
    const failed = await ev.refundFailed!(r)
    eq(statusOf(await deliver(w.deps, failed)), "applied", "the failed refund")
    eq(statusOf(await deliver(w.deps, failed)), "replayed", "the failed refund twice")
    eq(await credits(w.storage, "acme", w.m), full, "credits after the refund failed")
  })

  // ── SET-22 disputes ──
  add("SET-22", "an inquiry freezes nothing; a partial dispute freezes and takes its share; lost then won gives back; two disputes never take more than the payment", { events: ["payment", "dispute", "inquiry"], applies: c => c.disputes, capability: "disputes" }, async () => {
    const w = world()
    const payReq = await ev.payment!(paymentOf())
    const pm = await movementOf(payReq)
    await deliver(w.deps, payReq)
    const spendable = () => w.storage.spendableBalance("acme", w.m.primaryAsset)
    const full = await spendable()
    const at = ctx.clock.nowMs()
    eq((await deliver(w.deps, ev.inquiry!({ ref: ref(), paymentMovement: pm, amountMinor: 2000, currency: "EUR", at }))).type, "ignored", "an inquiry")
    eq(await spendable(), full, "spendable after an inquiry")
    const d1 = ref()
    const dispute = (r: string, status: "opened" | "won" | "lost", amountMinor: number) => deliver(w.deps, ev.dispute!({ ref: r, paymentMovement: pm, status, amountMinor, currency: "EUR", at }))
    await dispute(d1, "opened", 500)
    const frozen = full - (await spendable())
    check(frozen > 0 && frozen < full, `a dispute of a quarter froze ${frozen} of ${full}`)
    await dispute(d1, "lost", 500)
    const lost = await credits(w.storage, "acme", w.m)
    check(lost < full, "a lost dispute took nothing back")
    await dispute(d1, "won", 500)
    eq(await credits(w.storage, "acme", w.m), full, "credits after lost then won")
    const [a, b] = [ref(), ref()]
    await dispute(a, "lost", 1500)
    await dispute(b, "lost", 1500)
    const left = await credits(w.storage, "acme", w.m)
    check(left >= 0, "the account went negative")
    eq(await spendable(), left, "nothing stays frozen")
  })

  return cases
}
