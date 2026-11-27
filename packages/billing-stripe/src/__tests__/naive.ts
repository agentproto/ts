/**
 * The NAIVE translation, kept only as the baseline of the rule tests: a direct
 * switch on the event type, as a first reading of the Stripe reference would
 * write it. Not shipped (test directory), not exported. Every rule of
 * `rules.ts` must FAIL against it (`naive.test.ts`): that is the proof that
 * each rule tests something the obvious code gets wrong.
 *
 * What it does, on purpose: reads the first `v1` only; checks neither the
 * timestamp, the mode, nor the API version; keeps the secret on the object;
 * gives a payment fact for every payment event, whatever its status or its
 * metadata; reads the invoice payment from `invoice.payments` (absent from
 * the event body); takes `charge.refunded` and every `refund.*` as a refund;
 * maps a dispute by its event type.
 */
import { createHmac } from "node:crypto"
import type { RailFact, SettlementProvider, WebhookRequest } from "@agentproto/billing"
import type { StripeEventLike } from "../client.js"
import { STRIPE_CAPABILITIES, STRIPE_ENV, type StripeProviderConfig } from "../provider.js"

type Obj = Record<string, any>

export function createNaiveProvider(cfg: StripeProviderConfig): SettlementProvider {
  const md = (o: Obj | null | undefined) => (o ?? {}) as Obj
  const owner = (m: Obj) => Object.fromEntries(cfg.ownerKeys.map(k => [k, String(m[`agentproto_owner_${k}`] ?? "")]))
  const provider = {
    id: "stripe",
    name: "Stripe (naive)",
    env: { ...STRIPE_ENV },
    capabilities: { ...STRIPE_CAPABILITIES },
    secretKey: cfg.secretKey,
    webhookSecret: cfg.webhookSecret,
    async charge() {
      return { ok: false, error: "unsupported" }
    },
    async pay() {
      return { ok: false, error: "unsupported" }
    },
    async check() {
      return cfg.secretKey ? { ok: true } : { ok: false, reason: "no key" }
    },
    async verifyWebhook(raw: WebhookRequest): Promise<RailFact | null> {
      const header = raw.headers["stripe-signature"] ?? raw.headers["Stripe-Signature"] ?? ""
      const t = /t=(\d+)/.exec(header)?.[1]
      const v1 = /v1=([0-9a-f]+)/.exec(header)?.[1]
      const expected = createHmac("sha256", cfg.webhookSecret ?? "").update(`${t}.${raw.body}`).digest("hex")
      if (v1 !== expected) throw new Error(`bad signature: expected ${expected} with secret ${cfg.webhookSecret}`)
      const e = JSON.parse(raw.body) as StripeEventLike
      const o = e.data.object as Obj
      const at = e.created * 1000
      const pay = (movement: string, m: Obj, amount: number, tax: number): RailFact => ({ type: "payment", movement, rail: "stripe", offerId: String(m.agentproto_offer ?? ""), owner: owner(m), amountMinor: amount, taxMinor: tax, currency: String(o.currency).toUpperCase(), paidAt: at })
      switch (e.type) {
        case "payment_intent.succeeded":
          return pay(`stripe:${o.id}`, md(o.metadata), o.amount_received, 0)
        case "charge.succeeded":
          return pay(`stripe:${o.payment_intent}`, md(o.metadata), o.amount, 0)
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded":
          return pay(`stripe:${o.payment_intent}`, md(o.metadata), o.amount_total, o.total_details?.amount_tax ?? 0)
        case "invoice.paid":
          return pay(`stripe:${o.payments?.data?.[0]?.payment?.payment_intent}`, md(o.parent?.subscription_details?.metadata), o.amount_paid, (o.total_taxes ?? []).reduce((s: number, x: Obj) => s + x.amount, 0))
        case "invoice.payment_failed":
          return { type: "renewal_failed", movement: `stripe:${o.id}`, rail: "stripe", offerId: String(md(o.parent?.subscription_details?.metadata).agentproto_offer), owner: owner(md(o.parent?.subscription_details?.metadata)), at }
        case "customer.subscription.deleted":
          return { type: "subscription_ended", movement: `stripe:${o.id}`, rail: "stripe", offerId: String(md(o.metadata).agentproto_offer), owner: owner(md(o.metadata)), reason: "canceled", at }
        case "charge.refunded":
          return { type: "refund", movement: `stripe:${o.refunds?.data?.[0]?.id ?? o.id}`, rail: "stripe", paymentMovement: `stripe:${o.payment_intent}`, amountMinor: o.amount_refunded, at }
        case "refund.created":
        case "refund.updated":
          return { type: "refund", movement: `stripe:${o.id}`, rail: "stripe", paymentMovement: `stripe:${o.payment_intent}`, amountMinor: o.amount, at }
        case "refund.failed":
          return { type: "refund_reversed", movement: `stripe:${o.id}`, rail: "stripe", paymentMovement: `stripe:${o.payment_intent}`, amountMinor: o.amount, at }
        case "charge.dispute.created":
          return { type: "dispute", movement: `stripe:${o.id}`, rail: "stripe", paymentMovement: `stripe:${o.payment_intent}`, status: "opened", amountMinor: o.amount, currency: String(o.currency).toUpperCase(), at }
        case "charge.dispute.closed":
          return { type: "dispute", movement: `stripe:${o.id}`, rail: "stripe", paymentMovement: `stripe:${o.payment_intent}`, status: o.status === "won" ? "won" : "lost", amountMinor: o.amount, currency: String(o.currency).toUpperCase(), at }
        default:
          return null
      }
    },
  }
  return provider as SettlementProvider
}
