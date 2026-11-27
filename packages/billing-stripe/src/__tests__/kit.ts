/**
 * Test kit: the fixtures (built by hand from Stripe's public API reference,
 * not recorded), a Stripe client double (it replays the invoice payment
 * reads, keeps products, prices, sessions and refunds in memory, and logs
 * every read and write), a signer with a secret made for each run, and the
 * factory of signed requests the SET-* contract cases need.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { RailMode, SettlementProvider } from "@agentproto/billing"
import type { SettlementEvents } from "@agentproto/billing/contract-tests"
import { InMemoryBillingState, InMemoryStorage, ManualClock } from "@agentproto/billing/testing"
import { loadBillingManifest } from "@agentproto/billing/manifest"
import type { StripeCatalog } from "../catalog.js"
import type {
  StripeCheckoutSessionCreateParamsLike,
  StripeEventLike,
  StripeInvoicePaymentLike,
  StripeLike,
  StripeListLike,
  StripePriceCreateParamsLike,
  StripePriceLike,
  StripeProductCreateParamsLike,
  StripeProductLike,
  StripeRequestOptionsLike,
} from "../client.js"
import type { StripeProviderConfig } from "../provider.js"
import { STRIPE_REFERENCE_MANIFEST } from "./manifest.js"
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

/** An error shaped like the SDK's (`type`, `code`, `statusCode`, `raw`, `headers`). */
export class FakeStripeError extends Error {
  constructor(
    message: string,
    readonly type: string,
    readonly code?: string,
    readonly statusCode = 400,
    readonly raw: unknown = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

export interface ClientCall {
  method: string
  kind: "read" | "write"
  params: unknown
  options?: StripeRequestOptionsLike
}

/**
 * The Stripe client double. Invoice payments come from what the test
 * registered; products, prices, checkout sessions and refunds live in
 * memory, as Stripe would keep them. Every call is logged, read or write.
 */
export class FakeStripeClient implements StripeLike {
  readonly payments = new Map<string, StripeInvoicePaymentLike[]>()
  readonly productsById = new Map<string, StripeProductLike>()
  readonly pricesById = new Map<string, StripePriceLike>()
  readonly sessions = new Map<string, StripeCheckoutSessionCreateParamsLike>()
  readonly refundsByKey = new Map<string, { id: string; status: string; payment_intent: string; amount: number }>()
  readonly log: ClientCall[] = []
  /** Invoice payment reads (the webhook side). */
  calls = 0
  failing = false
  /** The account the key belongs to, for `accounts.retrieveCurrent`. */
  accountId = "acct_1Ex0Account0001"
  /** When set, `accounts.retrieveCurrent` throws it (a restricted key without read access, say). */
  accountError: Error | null = null
  /** When set, `refunds.create` throws it. */
  refundError: Error | null = null
  #n = 0
  get reads(): number {
    return this.log.filter(c => c.kind === "read").length
  }
  get writes(): number {
    return this.log.filter(c => c.kind === "write").length
  }
  #id(prefix: string): string {
    return `${prefix}_${(++this.#n).toString().padStart(4, "0")}Ex0`
  }
  #record(method: string, kind: "read" | "write", params: unknown, options?: StripeRequestOptionsLike) {
    this.log.push({ method, kind, params: structuredClone(params), ...(options ? { options: { ...options } } : {}) })
  }
  readonly invoicePayments = {
    list: async (params: { invoice?: string; status?: string; limit?: number }): Promise<StripeListLike<StripeInvoicePaymentLike>> => {
      this.calls++
      this.#record("invoicePayments.list", "read", params)
      if (this.failing) throw new Error("stripe: connection error (test double)")
      const all = (this.payments.get(params.invoice ?? "") ?? []).filter(p => params.status === undefined || p.status === params.status)
      const limit = params.limit ?? 10
      return { data: all.slice(0, limit), has_more: all.length > limit }
    },
  }
  readonly accounts = {
    retrieveCurrent: async (): Promise<{ id: string }> => {
      this.#record("accounts.retrieveCurrent", "read", {})
      if (this.accountError) throw this.accountError
      return { id: this.accountId }
    },
  }
  readonly refunds = {
    create: async (params: { payment_intent: string; amount: number; metadata?: Record<string, string> }, options?: StripeRequestOptionsLike) => {
      this.#record("refunds.create", "write", params, options)
      if (this.refundError) throw this.refundError
      const key = options?.idempotencyKey
      const known = key !== undefined ? this.refundsByKey.get(key) : undefined
      if (known) return { ...known }
      const r = { id: this.#id("re"), status: "succeeded", payment_intent: params.payment_intent, amount: params.amount }
      this.refundsByKey.set(key ?? r.id, r)
      return { ...r }
    },
  }
  readonly checkout = {
    sessions: {
      create: async (params: StripeCheckoutSessionCreateParamsLike, options?: StripeRequestOptionsLike) => {
        this.#record("checkout.sessions.create", "write", params, options)
        const id = this.#id("cs_test")
        this.sessions.set(id, structuredClone(params))
        return { id, url: `https://checkout.example.com/c/pay/${id}` }
      },
    },
  }
  readonly billingPortal = {
    sessions: {
      create: async (params: { customer: string; return_url: string }, options?: StripeRequestOptionsLike) => {
        this.#record("billingPortal.sessions.create", "write", params, options)
        return { url: `https://billing.example.com/p/session/${this.#id("bps")}` }
      },
    },
  }
  readonly products = {
    list: async (params: { ids?: string[]; limit?: number }): Promise<StripeListLike<StripeProductLike>> => {
      this.#record("products.list", "read", params)
      const data = [...this.productsById.values()].filter(p => params.ids === undefined || params.ids.includes(p.id))
      return { data: data.slice(0, params.limit ?? 10).map(p => structuredClone(p)), has_more: data.length > (params.limit ?? 10) }
    },
    create: async (params: StripeProductCreateParamsLike, options?: StripeRequestOptionsLike): Promise<StripeProductLike> => {
      this.#record("products.create", "write", params, options)
      if (this.productsById.has(params.id)) throw new FakeStripeError(`Product already exists.`, "StripeInvalidRequestError", "resource_already_exists")
      const p: StripeProductLike = { id: params.id, name: params.name, active: true, metadata: { ...params.metadata } }
      this.productsById.set(p.id, p)
      return structuredClone(p)
    },
    update: async (id: string, params: { name?: string; active?: boolean; metadata?: Record<string, string> }, options?: StripeRequestOptionsLike): Promise<StripeProductLike> => {
      this.#record("products.update", "write", { id, ...params }, options)
      const p = this.productsById.get(id)
      if (!p) throw new FakeStripeError(`No such product: '${id}'`, "StripeInvalidRequestError", "resource_missing", 404)
      Object.assign(p, { ...(params.name !== undefined ? { name: params.name } : {}), ...(params.active !== undefined ? { active: params.active } : {}), metadata: { ...p.metadata, ...params.metadata } })
      return structuredClone(p)
    },
  }
  readonly prices = {
    list: async (params: { lookup_keys?: string[]; limit?: number }): Promise<StripeListLike<StripePriceLike>> => {
      this.#record("prices.list", "read", params)
      if ((params.lookup_keys?.length ?? 0) > 10) throw new FakeStripeError("You can specify up to 10 lookup_keys.", "StripeInvalidRequestError", "parameter_invalid")
      const data = [...this.pricesById.values()].filter(p => params.lookup_keys === undefined || (p.lookup_key !== null && params.lookup_keys.includes(p.lookup_key)))
      return { data: data.slice(0, params.limit ?? 10).map(p => structuredClone(p)), has_more: data.length > (params.limit ?? 10) }
    },
    create: async (params: StripePriceCreateParamsLike, options?: StripeRequestOptionsLike): Promise<StripePriceLike> => {
      this.#record("prices.create", "write", params, options)
      this.#putPrice(params)
      return structuredClone([...this.pricesById.values()].at(-1)!)
    },
  }
  #putPrice(params: StripePriceCreateParamsLike): void {
    const holder = [...this.pricesById.values()].find(p => p.lookup_key === params.lookup_key)
    if (holder && !params.transfer_lookup_key) throw new FakeStripeError(`A price (\`${holder.id}\`) already uses that lookup key.`, "StripeInvalidRequestError", "lookup_key_already_used")
    if (holder) holder.lookup_key = null
    const id = this.#id("price")
    this.pricesById.set(id, {
      id,
      active: true,
      currency: params.currency,
      unit_amount: params.unit_amount,
      lookup_key: params.lookup_key,
      product: params.product,
      recurring: params.recurring ? { interval: params.recurring.interval, interval_count: params.recurring.interval_count ?? 1 } : null,
      tax_behavior: params.tax_behavior ?? "unspecified",
      metadata: { ...params.metadata },
    })
  }
  /** Put the products and prices of some offers of a catalog in place, as if an earlier sync had run. Not logged. */
  seed(catalog: StripeCatalog, offerIds?: readonly string[]): void {
    for (const o of catalog.offers) {
      if (offerIds && !offerIds.includes(o.offerId)) continue
      this.productsById.set(o.product.id, { id: o.product.id, name: o.product.name, active: true, metadata: { ...o.product.metadata } })
      if (o.price) {
        const p = o.price
        this.#putPrice({ product: p.product, currency: p.currency, unit_amount: p.unitAmount, lookup_key: p.lookupKey, transfer_lookup_key: true, metadata: p.metadata, ...(p.recurring ? { recurring: p.recurring } : {}), ...(p.taxBehavior ? { tax_behavior: p.taxBehavior } : {}) })
      }
    }
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

/** The reference manifest of the SET-* cases, on a `stripe` rail. */
export const referenceManifest = () => loadBillingManifest(STRIPE_REFERENCE_MANIFEST, { strategies: [] })

/** The one origin the kit's providers accept for return URLs. */
export const SHOP_ORIGIN = "https://shop.example.com"

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
  const manifest = referenceManifest()
  const unhandled: Unhandled[] = []
  const config = (over: Partial<StripeProviderConfig> = {}): StripeProviderConfig => ({
    secretKey,
    webhookSecret,
    mode,
    client,
    manifest,
    ownerKeys: ["orgId"],
    allowedReturnOrigins: [SHOP_ORIGIN],
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
  return { mode, clock, webhookSecret, secretKey, client, manifest, unhandled, config, sign, seconds, stores }
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
    // The session the provider created, completed and paid: its metadata is what createCheckout set.
    checkoutCompleted: s => {
      const session = kit.client.sessions.get(s.checkoutRef)
      if (!session) throw new Error(`no checkout session '${s.checkoutRef}' was created`)
      const e = eventOf("checkout.session.completed", {
        id: `evt_${s.checkoutRef}`,
        created: created(s.at),
        livemode: live,
        object: { id: s.checkoutRef, mode: session.mode, amount_subtotal: s.amountMinor, amount_total: s.amountMinor, currency: s.currency.toLowerCase(), livemode: live, payment_intent: `pi_${s.checkoutRef.slice(3)}` },
      })
      // Replaced, not merged: only what the provider wrote on the session may come back.
      e.data.object.metadata = { ...session.metadata }
      return kit.sign(e)
    },
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
