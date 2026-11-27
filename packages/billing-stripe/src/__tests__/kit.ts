/**
 * Test kit: the fixtures (built by hand from Stripe's public API reference,
 * not recorded), a Stripe client double that replays the invoice payment
 * reads, a signer with a secret made for each run, and the factory of signed
 * requests the SET-* contract cases need.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { RailMode, SettlementProvider } from "@agentproto/billing"
import type { SettlementEvents } from "@agentproto/billing/contract-tests"
import { InMemoryBillingState, InMemoryStorage, ManualClock } from "@agentproto/billing/testing"
import type { StripeEventLike, StripeInvoicePaymentLike, StripeLike, StripeListLike } from "../client.js"
import type { StripeProviderConfig } from "../provider.js"
import { stripeSignatureHeader } from "../signature.js"

export const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url))

type Json = Record<string, unknown>
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> | null : T[K] | null }

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

function merge(base: Json, patch: Json): Json {
  const out: Json = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = isObj(v) && isObj(out[k]) ? merge(out[k] as Json, v) : v
  }
  return out
}

/** A fixture by file name (without `.json`), deep-copied. */
export function fixture(name: string): Json {
  return JSON.parse(readFileSync(`${FIXTURES_DIR}${name}.json`, "utf8")) as Json
}

/** An event fixture with its object patched (deep merge; arrays and `null` replace). */
export function eventOf(name: string, patch: { id?: string; created?: number; livemode?: boolean; api_version?: string | null; type?: string; object?: DeepPartial<Json> } = {}): StripeEventLike {
  const e = fixture(name) as unknown as StripeEventLike & Json
  const { object, ...top } = patch
  const merged = merge(e, top as Json) as unknown as StripeEventLike
  if (object) merged.data = { ...merged.data, object: merge(merged.data.object, object as Json) }
  return merged
}

/** The Stripe client double: invoice payments come from what the test registered. Counts calls; can be made to fail. */
export class FakeStripeClient implements StripeLike {
  readonly payments = new Map<string, StripeInvoicePaymentLike[]>()
  calls = 0
  failing = false
  readonly invoicePayments = {
    list: async (params: { invoice?: string; status?: string; limit?: number }): Promise<StripeListLike<StripeInvoicePaymentLike>> => {
      this.calls++
      if (this.failing) throw new Error("stripe: connection error (test double)")
      const all = (this.payments.get(params.invoice ?? "") ?? []).filter(p => params.status === undefined || p.status === params.status)
      const limit = params.limit ?? 10
      return { data: all.slice(0, limit), has_more: all.length > limit }
    },
  }
  /** Register the payments of an invoice, shaped like the `invoice_payments.list` fixture. */
  setPayments(invoice: string, items: { paymentIntent: string; amountPaid: number; status?: string; type?: string }[]): void {
    const template = (fixture("invoice_payments.list") as { data: StripeInvoicePaymentLike[] }).data[0]!
    this.payments.set(
      invoice,
      items.map((it, i) => ({ ...template, id: `inpay_${invoice}_${i}`, amount_paid: it.amountPaid, status: it.status ?? "paid", payment: { type: it.type ?? "payment_intent", payment_intent: it.paymentIntent } })),
    )
  }
}

export interface Unhandled {
  event: StripeEventLike
  reason: string
}

export type ProviderMaker = (cfg: StripeProviderConfig) => SettlementProvider

/** One world of a test: secrets of this run, a client double, a clock, stores, a signer. */
export function makeKit(opts: { mode?: RailMode; clock?: ManualClock } = {}) {
  const mode = opts.mode ?? "test"
  const clock = opts.clock ?? new ManualClock(Date.UTC(2026, 10, 20, 12, 0, 0))
  const webhookSecret = `whsec_${globalThis.crypto.randomUUID().replace(/-/g, "")}`
  const secretKey = `sk_${mode}_${globalThis.crypto.randomUUID().replace(/-/g, "")}`
  const client = new FakeStripeClient()
  const unhandled: Unhandled[] = []
  const config = (over: Partial<StripeProviderConfig> = {}): StripeProviderConfig => ({
    secretKey,
    webhookSecret,
    mode,
    client,
    ownerKeys: ["orgId"],
    onUnhandled: (event, reason) => void unhandled.push({ event, reason }),
    now: () => clock.nowMs(),
    ...over,
  })
  const seconds = () => Math.floor(clock.nowMs() / 1000)
  /** A request signed with this run's secret, at the clock's time. */
  const sign = (event: StripeEventLike, secret = webhookSecret) => {
    const body = JSON.stringify(event)
    return { body, headers: { "stripe-signature": stripeSignatureHeader(body, secret, seconds()) } }
  }
  const stores = () => ({ storage: new InMemoryStorage(clock), state: new InMemoryBillingState() })
  return { mode, clock, webhookSecret, secretKey, client, unhandled, config, sign, seconds, stores }
}

export type Kit = ReturnType<typeof makeKit>

const SUBSCRIPTION_OFFERS = new Set(["plan-month", "plan-year", "plan-keep", "plan-trial"])
const owner = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`agentproto_owner_${k}`, v]))
const pi = (movement: string) => movement.slice("stripe:".length)

/** The SET-* scenarios as Stripe events, signed with the kit's secret. */
export function stripeEvents(kit: Kit): SettlementEvents {
  const live = kit.mode === "live"
  const created = (at: number) => Math.floor(at / 1000)
  const payment = (s: { ref: string; offerId: string; owner: Record<string, string>; amountMinor: number; currency: string; at: number }, livemode = live) => {
    const metadata = { agentproto_offer: s.offerId, ...owner(s.owner) }
    if (SUBSCRIPTION_OFFERS.has(s.offerId)) {
      kit.client.setPayments(`in_${s.ref}`, [{ paymentIntent: `pi_${s.ref}`, amountPaid: s.amountMinor }])
      return kit.sign(
        eventOf("invoice.paid", {
          id: `evt_inv_${s.ref}`,
          created: created(s.at),
          livemode,
          object: { id: `in_${s.ref}`, amount_due: s.amountMinor, amount_paid: s.amountMinor, subtotal: s.amountMinor, total: s.amountMinor, currency: s.currency.toLowerCase(), livemode, parent: { subscription_details: { metadata, subscription: `sub_${s.ref}` } } },
        }),
      )
    }
    return kit.sign(
      eventOf("checkout.session.completed", {
        id: `evt_cs_${s.ref}`,
        created: created(s.at),
        livemode,
        object: { id: `cs_${s.ref}`, amount_subtotal: s.amountMinor, amount_total: s.amountMinor, currency: s.currency.toLowerCase(), livemode, metadata, payment_intent: `pi_${s.ref}` },
      }),
    )
  }
  return {
    payment: s => payment(s),
    // The payment intent of a checkout carries none of the session's metadata.
    paymentIncomplete: s =>
      kit.sign(eventOf("payment_intent.succeeded", { id: `evt_pi_${s.ref}`, created: created(s.at), livemode: live, object: { id: `pi_${s.ref}`, amount: s.amountMinor, amount_received: s.amountMinor, currency: s.currency.toLowerCase(), livemode: live } })),
    refund: s => kit.sign(eventOf("refund.updated", { id: `evt_reu_${s.ref}`, created: created(s.at), livemode: live, object: { id: `re_${s.ref}`, amount: s.amountMinor, payment_intent: pi(s.paymentMovement), status: "succeeded" } })),
    refundPending: s => kit.sign(eventOf("refund.created", { id: `evt_rec_${s.ref}`, created: created(s.at), livemode: live, object: { id: `re_${s.ref}`, amount: s.amountMinor, payment_intent: pi(s.paymentMovement), status: "pending" } })),
    refundFailed: s => kit.sign(eventOf("refund.failed", { id: `evt_ref_${s.ref}`, created: created(s.at), livemode: live, object: { id: `re_${s.ref}`, amount: s.amountMinor, payment_intent: pi(s.paymentMovement), status: "failed" } })),
    dispute: s => {
      const status = s.status === "opened" ? "needs_response" : s.status
      const type = s.status === "opened" ? "charge.dispute.created" : "charge.dispute.closed"
      return kit.sign(eventOf(type, { id: `evt_dp_${s.ref}_${status}`, created: created(s.at), livemode: live, object: { id: `dp_${s.ref}`, amount: s.amountMinor, currency: s.currency.toLowerCase(), payment_intent: pi(s.paymentMovement), status, livemode: live } }))
    },
    inquiry: s =>
      kit.sign(eventOf("charge.dispute.created", { id: `evt_dpw_${s.ref}`, created: created(s.at), livemode: live, object: { id: `dp_${s.ref}`, amount: s.amountMinor, currency: s.currency.toLowerCase(), payment_intent: pi(s.paymentMovement), status: "warning_needs_response", livemode: live } })),
    renewalFailed: s =>
      kit.sign(eventOf("invoice.payment_failed", { id: `evt_inf_${s.ref}`, created: created(s.at), livemode: live, object: { id: `in_${s.ref}`, livemode: live, parent: { subscription_details: { metadata: { agentproto_offer: s.offerId, ...owner(s.owner) } } } } })),
    subscriptionEnded: s =>
      kit.sign(
        eventOf("customer.subscription.deleted", {
          id: `evt_sub_${s.ref}`,
          created: created(s.at),
          livemode: live,
          object: { id: `sub_${s.ref}`, ended_at: created(s.at), canceled_at: created(s.at), livemode: live, metadata: { agentproto_offer: s.offerId, ...owner(s.owner) }, cancellation_details: { reason: s.reason === "unpaid" ? "payment_failed" : "cancellation_requested" } },
        }),
      ),
    noMoney: s => kit.sign(eventOf("customer.updated", { id: `evt_cus_${s.ref}`, created: created(s.at), livemode: live })),
    badSignature: s => kit.sign(eventOf("checkout.session.completed", { id: `evt_bad_${s.ref}`, created: created(s.at), livemode: live }), `whsec_${globalThis.crypto.randomUUID().replace(/-/g, "")}`),
    wrongMode: s => payment(s, !live),
  }
}
