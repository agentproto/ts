/**
 * The Stripe rules of this adapter (SET-1 with two `v1`, SET-8, SET-9,
 * SET-13 to SET-23), each one written once against a provider MAKER, so that
 * the same rule runs against this adapter (`rules.test.ts`, green) and against
 * the naive translation (`naive.ts`: a direct switch on the event type), where
 * each rule must fail (`naive.test.ts`). Each run throws on failure.
 */
import { handleWebhook, listOwed, type BillingDeps, type FactOutcome, type SettlementProvider, type WebhookRequest } from "@agentproto/billing"
import { loadBillingManifest } from "@agentproto/billing/manifest"
import type { StripeEventLike } from "../client.js"
import { stripeSignatureHeader } from "../signature.js"
import { eventOf, makeKit, type Kit, type ProviderMaker } from "./kit.js"
import { STRIPE_REFERENCE_MANIFEST } from "./manifest.js"

export interface Rule {
  id: string
  title: string
  run: (make: ProviderMaker) => Promise<void>
  /**
   * Set when the naive translation passes this rule too, with the reason: the
   * guard then lives in the core, not in the adapter. `naive.test.ts` checks
   * that such a rule does pass on the naive translation, so the statement
   * stays true.
   */
  naivePasses?: string
}

class RuleError extends Error {}
const check = (cond: unknown, msg: string): void => {
  if (!cond) throw new RuleError(msg)
}
const eq = (a: unknown, b: unknown, msg: string): void => check(Object.is(a, b), `${msg}: expected ${String(b)}, got ${String(a)}`)
const throws = async (fn: () => unknown, msg: string): Promise<Error> => {
  try {
    await fn()
  } catch (e) {
    return e as Error
  }
  throw new RuleError(`${msg}: did not throw`)
}
const statusOf = (o: FactOutcome): string => ("outcome" in o ? (o.outcome as { status: string }).status : o.type)

function world(make: ProviderMaker, over: Parameters<Kit["config"]>[0] = {}, kitOpts: Parameters<typeof makeKit>[0] = {}) {
  const kit = makeKit(kitOpts)
  const provider = make(kit.config(over))
  const { storage, state } = kit.stores()
  const m = loadBillingManifest(STRIPE_REFERENCE_MANIFEST, { strategies: [] })
  const deps: BillingDeps = { manifest: m, storage, clock: kit.clock, state }
  const deliver = (e: StripeEventLike | WebhookRequest) => handleWebhook(deps, provider, "body" in e ? e : kit.sign(e))
  const spendable = () => storage.spendableBalance("acme", m.primaryAsset)
  const journal = async () => (await storage.loadEvents("acme")).length
  const owed = () => listOwed(storage, "acme", kit.clock.nowMs())
  const created = kit.seconds()
  return { kit, provider, deps, storage, state, m, deliver, spendable, journal, owed, created }
}

/** A paid one-time checkout of `pack-20` (2000 EUR), with its payment intent. */
const checkoutPaid = (ref: string, created: number, object: Record<string, unknown> = {}, livemode?: boolean) =>
  eventOf("checkout.session.completed", { id: `evt_cs_${ref}`, created, ...(livemode !== undefined ? { livemode } : {}), object: { id: `cs_${ref}`, payment_intent: `pi_${ref}`, ...object } })

/** A paid subscription invoice of `plan-month` (500 EUR). */
const invoicePaid = (ref: string, created: number, object: Record<string, unknown> = {}) =>
  eventOf("invoice.paid", { id: `evt_in_${ref}`, created, object: { id: `in_${ref}`, ...object } })

export const RULES: Rule[] = [
  {
    id: "SET-1",
    title: "two v1 signatures, the second one right: accepted; a timestamp past the tolerance: refused",
    run: async make => {
      const w = world(make)
      const e = checkoutPaid("sig2", w.created)
      const body = JSON.stringify(e)
      const t = w.kit.seconds()
      const good = stripeSignatureHeader(body, w.kit.webhookSecret, t).split(",v1=")[1]!
      const old = stripeSignatureHeader(body, `whsec_${"0".repeat(32)}`, t).split(",v1=")[1]!
      const header = `t=${t},v1=${old},v1=${good},v0=${"f".repeat(64)}`
      eq(statusOf(await w.deliver({ body, headers: { "Stripe-Signature": header } })), "applied", "a request whose second v1 is right")
      const stale = { body, headers: { "stripe-signature": stripeSignatureHeader(body, w.kit.webhookSecret, t - 301) } }
      await throws(() => w.deliver(stale), "a signature 301 s old")
    },
  },
  {
    id: "SET-8",
    title: "no secret in JSON.stringify, String(), the signature, mode and version errors, or check()",
    run: async make => {
      const w = world(make)
      const secrets = [w.kit.secretKey, w.kit.webhookSecret]
      const texts = [JSON.stringify(w.provider), String(w.provider)]
      const leaks = (t: string) => [...secrets, w.kit.secretKey.slice(8)].filter(x => t.includes(x))
      check(leaks(texts.join(" ")).length === 0, "a secret leaked into JSON.stringify(provider) or String(provider)")
      const bad = await throws(() => w.provider.verifyWebhook(w.kit.sign(checkoutPaid("s8", w.created), "whsec_other")), "a wrong signature")
      texts.push(`${bad.message} ${bad.stack ?? ""}`)
      const mode = await throws(() => w.provider.verifyWebhook(w.kit.sign(checkoutPaid("s8m", w.created, { livemode: true }, true))), "an event of the other mode")
      texts.push(`${mode.message} ${mode.stack ?? ""}`)
      const version = await throws(() => w.provider.verifyWebhook(w.kit.sign(eventOf("checkout.session.completed", { api_version: "2024-06-20" }))), "an event of another API version")
      texts.push(`${version.message} ${version.stack ?? ""}`)
      const wrongKey = make(w.kit.config({ secretKey: `sk_live_${w.kit.secretKey.slice(8)}` }))
      texts.push(JSON.stringify(await wrongKey.check!()))
      for (const t of texts) check(leaks(t).length === 0, `a secret leaked: '${t.slice(0, 120)}'`)
    },
  },
  {
    id: "SET-9",
    title: "an event of the other mode throws and writes nothing; a key of the other mode fails check()",
    run: async make => {
      const w = world(make)
      await throws(() => w.deliver(checkoutPaid("live1", w.created, { livemode: true }, true)), "a live event on a test rail")
      eq(await w.journal(), 0, "journal after the live event")
      const live = make(w.kit.config({ secretKey: `sk_live_${"a".repeat(24)}` }))
      const r = await live.check!()
      check(!r.ok && typeof r.reason === "string" && r.reason.length > 0, "check() passes with a live key on a test rail")
      const restricted = make(w.kit.config({ secretKey: `rk_live_${"a".repeat(24)}` }))
      check(!(await restricted.check!()).ok, "check() passes with a live restricted key on a test rail")
      const ok = make(w.kit.config({ secretKey: `rk_test_${"a".repeat(24)}` }))
      check((await ok.check!()).ok, "check() fails with a test restricted key on a test rail")
      const lw = world(make, {}, { mode: "live" })
      await throws(() => lw.deliver(checkoutPaid("test1", lw.created, { livemode: false }, false)), "a test event on a live rail")
      eq(await lw.journal(), 0, "journal after the test event on the live rail")
    },
  },
  {
    id: "SET-13",
    title: "payment_intent.succeeded then checkout.session.completed give the journal of the reverse order, nothing owed",
    naivePasses:
      "the core already completes a payment it refused for a missing offer when the valid fact of the same movement lands (payment.ts, replay decided on the effect), so the naive fact without an offer is owed only until the session event arrives",
    run: async make => {
      const shape = async (w: ReturnType<typeof world>) => (await w.storage.loadEvents("acme")).map(e => `${e.id}|${e.kind}|${e.amount}`).sort().join("\n")
      // The intent carries the payer (a host may copy it there) but not the offer.
      const intent = (created: number) => eventOf("payment_intent.succeeded", { id: "evt_pi_13", created, object: { id: "pi_13", metadata: { agentproto_owner_orgId: "acme" } } })
      const a = world(make)
      await a.deliver(checkoutPaid("13", a.created))
      await a.deliver(intent(a.created))
      const b = world(make)
      await b.deliver(intent(b.created))
      await b.deliver(checkoutPaid("13", b.created))
      eq(await shape(b), await shape(a), "journal, intent first")
      eq((await b.owed()).length, 0, "owed entries, intent first")
      eq(await b.spendable(), await a.spendable(), "credits")
    },
  },
  {
    id: "SET-14",
    title: "checkout.session.completed unpaid writes nothing; async_payment_succeeded writes once",
    run: async make => {
      const w = world(make)
      const unpaid = checkoutPaid("14", w.created, { payment_status: "unpaid" })
      eq((await w.deliver(unpaid)).type, "ignored", "a completed session not paid yet")
      eq(await w.journal(), 0, "journal before the money arrived")
      eq(await w.spendable(), 0, "credits before the money arrived")
      const later = eventOf("checkout.session.async_payment_succeeded", { id: "evt_async_14", created: w.created, object: { id: "cs_14", payment_intent: "pi_14" } })
      eq(statusOf(await w.deliver(later)), "applied", "the delayed payment")
      const len = await w.journal()
      eq(statusOf(await w.deliver(later)), "replayed", "the delayed payment twice")
      eq(await w.journal(), len, "journal after the replay")
      eq((await w.deliver(eventOf("checkout.session.completed", { type: "checkout.session.async_payment_failed", id: "evt_asyncf_14", created: w.created, object: { id: "cs_x14", payment_intent: "pi_x14", payment_status: "unpaid" } }))).type, "ignored", "a failed delayed payment")
    },
  },
  {
    id: "SET-15",
    title: "an invoice settled by two payments: one unsupported fact, refused, the amount paid owed, no credit, onUnhandled once",
    run: async make => {
      const w = world(make)
      w.kit.client.setPayments("in_15", [
        { paymentIntent: "pi_15a", amountPaid: 300 },
        { paymentIntent: "pi_15b", amountPaid: 200 },
      ])
      const out = await w.deliver(invoicePaid("15", w.created))
      eq(statusOf(out), "refused", "an invoice of two payments")
      const owed = await w.owed()
      eq(owed.length, 1, "owed entries")
      eq(owed[0]?.remaining, 500, "owed amount")
      eq(owed[0]?.movement, "stripe:in_15", "owed movement")
      eq(await w.spendable(), 0, "credits")
      eq(w.kit.unhandled.length, 1, "onUnhandled calls")
    },
  },
  {
    id: "SET-16",
    title: "an exclusive tax is accepted, on a checkout and on an invoice",
    run: async make => {
      const w = world(make)
      const cs = checkoutPaid("16", w.created, { amount_subtotal: 2000, amount_total: 2400, total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 400 } })
      eq(statusOf(await w.deliver(cs)), "applied", "a checkout with a 400 exclusive tax")
      w.kit.client.setPayments("in_16", [{ paymentIntent: "pi_16i", amountPaid: 600 }])
      const inv = invoicePaid("16", w.created, { amount_paid: 600, total: 600, total_taxes: [{ amount: 100, tax_behavior: "exclusive", taxability_reason: "standard_rated", taxable_amount: 500, type: "tax_rate_details", tax_rate_details: null }] })
      eq(statusOf(await w.deliver(inv)), "applied", "an invoice with a 100 exclusive tax")
    },
  },
  {
    id: "SET-17",
    title: "a discount is accepted only on an offer that allows it",
    run: async make => {
      const w = world(make)
      const promo = checkoutPaid("17a", w.created, { amount_total: 1500, total_details: { amount_discount: 500, amount_shipping: 0, amount_tax: 0 }, metadata: { agentproto_offer: "pack-promo" } })
      eq(statusOf(await w.deliver(promo)), "applied", "a 500 discount on pack-promo (discounts: allow)")
      const plain = checkoutPaid("17b", w.created, { amount_total: 1500, total_details: { amount_discount: 500, amount_shipping: 0, amount_tax: 0 } })
      eq(statusOf(await w.deliver(plain)), "refused", "a 500 discount on pack-20")
    },
  },
  {
    id: "SET-18",
    title: "an invoice at 0 opens the trial, under the invoice id, without an API read",
    run: async make => {
      const w = world(make)
      const inv = invoicePaid("18", w.created, { amount_due: 0, amount_paid: 0, subtotal: 0, total: 0, billing_reason: "subscription_create", parent: { subscription_details: { metadata: { agentproto_offer: "plan-trial" } } } })
      eq(statusOf(await w.deliver(inv)), "applied", "a trial invoice at 0")
      const period = await w.state.getPeriod("stripe:in_18")
      eq(period?.status, "active", "the trial period, under stripe:in_18")
      eq(w.kit.client.calls, 0, "invoice payment reads")
    },
  },
  {
    id: "SET-19",
    title: "a proration invoice is listed as owed under its payment intent",
    run: async make => {
      const w = world(make)
      w.kit.client.setPayments("in_19", [{ paymentIntent: "pi_19", amountPaid: 250 }])
      const inv = invoicePaid("19", w.created, { amount_due: 250, amount_paid: 250, subtotal: 250, total: 250, billing_reason: "subscription_update" })
      eq(statusOf(await w.deliver(inv)), "refused", "a proration of 250 on a 500 plan")
      const owed = await w.owed()
      eq(owed.length, 1, "owed entries")
      eq(owed[0]?.movement, "stripe:pi_19", "owed movement")
      eq(await w.spendable(), 0, "credits")
    },
  },
  {
    id: "SET-20",
    title: "a payment without agentproto_offer, or outside offerNamespace, gives no fact and nothing owed",
    run: async make => {
      const w = world(make)
      eq((await w.deliver(checkoutPaid("20a", w.created, { metadata: { agentproto_offer: null } }))).type, "ignored", "a session without agentproto_offer")
      eq((await w.deliver(invoicePaid("20b", w.created, { parent: { subscription_details: { metadata: { agentproto_offer: null } } } }))).type, "ignored", "an invoice without agentproto_offer")
      eq(await w.journal(), 0, "journal")
      const ns = world(make, { offerNamespace: "shop-b/" })
      eq((await ns.deliver(checkoutPaid("20c", ns.created))).type, "ignored", "an offer outside the namespace")
      eq((await ns.owed()).length, 0, "owed entries")
      eq(await ns.journal(), 0, "journal outside the namespace")
    },
  },
  {
    id: "SET-21",
    title: "refund.created pending: nothing; refund.updated succeeded: taken once; refund.failed: given back once",
    run: async make => {
      const w = world(make)
      await w.deliver(checkoutPaid("21", w.created))
      const full = await w.spendable()
      const refund = (type: string, status: string) => eventOf(type, { id: `evt_${type}_${status}`, created: w.created, object: { id: "re_21", amount: 1000, payment_intent: "pi_21", status } })
      eq((await w.deliver(refund("refund.created", "pending"))).type, "ignored", "a pending refund")
      eq(await w.spendable(), full, "credits after a pending refund")
      eq(statusOf(await w.deliver(refund("refund.updated", "succeeded"))), "applied", "the succeeded refund")
      eq(statusOf(await w.deliver(refund("refund.updated", "succeeded"))), "replayed", "the succeeded refund twice")
      const after = await w.spendable()
      check(after < full, "the refund took nothing back")
      eq(statusOf(await w.deliver(refund("refund.failed", "failed"))), "applied", "the failed refund")
      eq(statusOf(await w.deliver(refund("refund.failed", "failed"))), "replayed", "the failed refund twice")
      eq(await w.spendable(), full, "credits after the refund failed")
    },
  },
  {
    id: "SET-22",
    title: "warning_needs_response freezes nothing; prevented after needs_response lifts the freeze; lost then won gives back",
    run: async make => {
      const w = world(make)
      await w.deliver(checkoutPaid("22", w.created))
      const full = await w.spendable()
      const dispute = (id: string, type: string, status: string) => eventOf("charge.dispute.created", { type, id: `evt_${id}_${status}`, created: w.created, object: { id, amount: 2000, payment_intent: "pi_22", status } })
      eq((await w.deliver(dispute("dp_22w", "charge.dispute.created", "warning_needs_response"))).type, "ignored", "an inquiry")
      eq(await w.spendable(), full, "spendable after an inquiry")
      await w.deliver(dispute("dp_22a", "charge.dispute.created", "needs_response"))
      check((await w.spendable()) < full, "a dispute froze nothing")
      await w.deliver(dispute("dp_22a", "charge.dispute.closed", "prevented"))
      eq(await w.spendable(), full, "spendable after a prevented dispute")
      await w.deliver(dispute("dp_22b", "charge.dispute.closed", "lost"))
      check((await w.spendable()) < full, "a lost dispute took nothing back")
      await w.deliver(dispute("dp_22b", "charge.dispute.funds_reinstated", "won"))
      eq(await w.spendable(), full, "credits after lost then won")
    },
  },
  {
    id: "SET-23",
    title: "charge.refunded gives no fact: two partial refunds, each announced by charge.refunded first, are taken back once each",
    run: async make => {
      const charge = (w: ReturnType<typeof world>, n: number) => eventOf("charge.refunded", { id: `evt_ch23_${n}`, created: w.created, object: { id: "ch_23", payment_intent: "pi_23", amount_refunded: 500 * n, refunds: { object: "list", data: [{ id: `re_23_${n}`, object: "refund", amount: 500, status: "succeeded", payment_intent: "pi_23" }], has_more: false } } })
      const refund = (w: ReturnType<typeof world>, n: number) => eventOf("refund.updated", { id: `evt_re23_${n}`, created: w.created, object: { id: `re_23_${n}`, amount: 500, payment_intent: "pi_23", status: "succeeded" } })
      // Expected: the two refunds alone.
      const b = world(make)
      await b.deliver(checkoutPaid("23", b.created))
      await b.deliver(refund(b, 1))
      await b.deliver(refund(b, 2))
      const w = world(make)
      await w.deliver(checkoutPaid("23", w.created))
      const full = await w.spendable()
      for (const n of [1, 2]) {
        eq((await w.deliver(charge(w, n))).type, "ignored", `charge.refunded before refund ${n}`)
        await w.deliver(refund(w, n))
      }
      check((await b.spendable()) < full, "two refunds took nothing back")
      eq(await w.spendable(), await b.spendable(), "credits after two refunds, each announced by charge.refunded")
    },
  },
  {
    id: "E3",
    title: "a failed read of the invoice payments throws, so Stripe retries; nothing is written",
    run: async make => {
      const w = world(make)
      w.kit.client.failing = true
      await throws(() => w.deliver(invoicePaid("e3", w.created)), "an invoice whose payments cannot be read")
      eq(await w.journal(), 0, "journal")
      w.kit.client.failing = false
      w.kit.client.setPayments("in_e3", [{ paymentIntent: "pi_e3", amountPaid: 500 }])
      eq(statusOf(await w.deliver(invoicePaid("e3", w.created))), "applied", "the retried invoice")
      eq((await w.state.getPeriod("stripe:pi_e3"))?.status, "active", "period under the payment intent")
    },
  },
]
