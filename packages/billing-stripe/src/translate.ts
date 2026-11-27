/**
 * From a verified Stripe event to at most one fact of `@agentproto/billing`.
 *
 * ONE source event per kind of payment, so that the several events Stripe
 * sends for one money movement never give two facts, nor a fact that lacks
 * the offer:
 *
 * - one-time checkout: `checkout.session.completed` once paid, or
 *   `checkout.session.async_payment_succeeded` for a delayed method;
 * - subscription (first payment and renewals): `invoice.paid` of an invoice
 *   with `parent.subscription_details`; its payment is read with
 *   `invoicePayments.list`, since the event body does not carry it;
 * - `payment_intent.succeeded`, `charge.succeeded`, `invoice.payment_succeeded`,
 *   `invoice_payment.paid`, a subscription-mode checkout: no fact.
 *
 * Refunds come from `refund.*` (one object per refund, never the cumulative
 * `charge.refunded`), disputes from `charge.dispute.*` through one rule on the
 * dispute status.
 */
import type { PaymentFact, RailFact } from "@agentproto/billing"
import { refId, type StripeEventLike, type StripeLike } from "./client.js"

/** Metadata key of the offer. */
export const OFFER_KEY = "agentproto_offer"
/** Metadata key prefix of the payer's owner keys: `agentproto_owner_<key>`. */
export const OWNER_KEY_PREFIX = "agentproto_owner_"

export interface TranslateContext {
  /** Rail id of the facts (`stripe`), also the movement prefix. */
  rail: string
  ownerKeys: readonly string[]
  offerNamespace?: string
  client: StripeLike
  /** A recognised money event that does not become an applicable fact. */
  unhandled: (event: StripeEventLike, reason: string) => Promise<void>
}

type Obj = Record<string, unknown>

const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null)

interface Scope {
  offerId: string
  owner: Record<string, string>
  missing: string[]
}

/** The offer and the payer named by the metadata, or null when the object is not ours (no offer, or outside the namespace). */
function scopeOf(metadata: unknown, ctx: TranslateContext): Scope | null {
  const md = obj(metadata) ?? {}
  const offerId = str(md[OFFER_KEY])
  if (offerId === null) return null
  if (ctx.offerNamespace !== undefined && !offerId.startsWith(ctx.offerNamespace)) return null
  const owner: Record<string, string> = {}
  const missing: string[] = []
  for (const k of ctx.ownerKeys) {
    const v = str(md[`${OWNER_KEY_PREFIX}${k}`])
    if (v === null) missing.push(k)
    else owner[k] = v
  }
  return { offerId, owner, missing }
}

async function reportMissingOwner(event: StripeEventLike, scope: Scope, ctx: TranslateContext): Promise<void> {
  if (scope.missing.length > 0) {
    await ctx.unhandled(event, `owner key${scope.missing.length > 1 ? "s" : ""} ${scope.missing.map(k => `'${OWNER_KEY_PREFIX}${k}'`).join(", ")} missing from the metadata: the core cannot find the account`)
  }
}

const atOf = (event: StripeEventLike): number => event.created * 1000

async function checkoutPayment(event: StripeEventLike, ctx: TranslateContext): Promise<RailFact | null> {
  const s = event.data.object
  if (s.mode !== "payment") return null
  const status = s.payment_status
  if (status !== "paid" && status !== "no_payment_required") return null
  const scope = scopeOf(s.metadata, ctx)
  if (!scope) return null
  const total = num(s.amount_total)
  const subtotal = num(s.amount_subtotal)
  const details = obj(s.total_details)
  const tax = num(details?.amount_tax) ?? 0
  const discount = num(details?.amount_discount) ?? 0
  const currency = str(s.currency)
  if (total === null || subtotal === null || currency === null) {
    await ctx.unhandled(event, "checkout session without amount_total, amount_subtotal or currency")
    return null
  }
  let taxBehavior: "inclusive" | "exclusive"
  if (total === subtotal - discount + tax && tax > 0) taxBehavior = "exclusive"
  else if (total === subtotal - discount) taxBehavior = "inclusive"
  else {
    await ctx.unhandled(event, `checkout session total ${total} is neither subtotal - discount (${subtotal - discount}) nor that plus tax (${subtotal - discount + tax}): shipping or another charge`)
    return null
  }
  const pi = refId(s.payment_intent)
  const sessionId = str(s.id)
  if (pi === null && !(total === 0 && sessionId !== null)) {
    await ctx.unhandled(event, "paid checkout session without payment_intent")
    return null
  }
  await reportMissingOwner(event, scope, ctx)
  return payment(ctx, {
    // A session that needed no payment (a full discount) moved no money: its own id is the movement.
    movement: `${ctx.rail}:${pi ?? sessionId}`,
    offerId: scope.offerId,
    owner: scope.owner,
    amountMinor: total,
    taxMinor: tax,
    taxBehavior,
    discountMinor: discount,
    currency,
    paidAt: atOf(event),
  })
}

function payment(ctx: TranslateContext, f: Omit<PaymentFact, "type" | "rail" | "currency"> & { currency: string }): PaymentFact {
  const fact: PaymentFact = { type: "payment", rail: ctx.rail, ...f, currency: f.currency.toUpperCase() }
  if (fact.discountMinor === 0) delete fact.discountMinor
  return fact
}

const subscriptionDetails = (invoice: Obj): Obj | null => obj(obj(invoice.parent)?.subscription_details)

async function invoicePaid(event: StripeEventLike, ctx: TranslateContext): Promise<RailFact | null> {
  const inv = event.data.object
  const details = subscriptionDetails(inv)
  if (!details) return null
  const scope = scopeOf(details.metadata, ctx)
  if (!scope) return null
  const invoiceId = str(inv.id)
  const paid = num(inv.amount_paid)
  const currency = str(inv.currency)
  if (invoiceId === null || paid === null || currency === null) {
    await ctx.unhandled(event, "paid invoice without id, amount_paid or currency")
    return null
  }
  const taxes = Array.isArray(inv.total_taxes) ? (inv.total_taxes as unknown[]).map(obj).filter((t): t is Obj => t !== null) : []
  const behaviors = new Set(taxes.map(t => t.tax_behavior))
  if (behaviors.size > 1) {
    await ctx.unhandled(event, "invoice with both inclusive and exclusive taxes: its price cannot be read back")
    return null
  }
  const taxMinor = taxes.reduce((s, t) => s + (num(t.amount) ?? 0), 0)
  const discounts = Array.isArray(inv.total_discount_amounts) ? (inv.total_discount_amounts as unknown[]).map(obj) : []
  const discountMinor = discounts.reduce((s, d) => s + (num(d?.amount) ?? 0), 0)
  const taxBehavior = behaviors.has("exclusive") ? "exclusive" : "inclusive"
  const base = { offerId: scope.offerId, owner: scope.owner, amountMinor: paid, taxMinor, taxBehavior, discountMinor, currency, paidAt: atOf(event) } as const
  await reportMissingOwner(event, scope, ctx)
  // A trial, or a full discount: no money moved, the invoice is the movement.
  if (paid === 0) return payment(ctx, { ...base, movement: `${ctx.rail}:${invoiceId}` })
  // The payments are not in the event body: read them. A failed read throws, so Stripe retries; never a partial fact.
  const list = await ctx.client.invoicePayments.list({ invoice: invoiceId, status: "paid", limit: 10 })
  const paidOnes = list.data.filter(p => p.status === "paid")
  const only = paidOnes.length === 1 && !list.has_more ? paidOnes[0]! : null
  const pi = only && only.payment.type === "payment_intent" ? refId(only.payment.payment_intent) : null
  if (only && pi !== null && only.amount_paid === paid) return payment(ctx, { ...base, movement: `${ctx.rail}:${pi}` })
  const why = list.has_more || paidOnes.length > 1
    ? `invoice settled by ${list.has_more ? "more than 10" : paidOnes.length} payments`
    : paidOnes.length === 0
      ? "invoice without a paid payment"
      : pi === null
        ? `invoice paid by a '${only!.payment.type}' payment, not a payment intent`
        : `invoice payment of ${only!.amount_paid} for an amount paid of ${paid}`
  await ctx.unhandled(event, `${why}: the money is listed as owed, no credit is given`)
  // The money arrived: it enters the journal as owed (refused by the core), under the invoice.
  return payment(ctx, { ...base, movement: `${ctx.rail}:${invoiceId}`, unsupported: why })
}

async function invoiceFailed(event: StripeEventLike, ctx: TranslateContext): Promise<RailFact | null> {
  const inv = event.data.object
  const details = subscriptionDetails(inv)
  if (!details) return null
  const scope = scopeOf(details.metadata, ctx)
  const invoiceId = str(inv.id)
  if (!scope || invoiceId === null) return null
  await reportMissingOwner(event, scope, ctx)
  return { type: "renewal_failed", movement: `${ctx.rail}:${invoiceId}`, rail: ctx.rail, offerId: scope.offerId, owner: scope.owner, at: atOf(event) }
}

async function subscriptionDeleted(event: StripeEventLike, ctx: TranslateContext): Promise<RailFact | null> {
  const sub = event.data.object
  const scope = scopeOf(sub.metadata, ctx)
  const id = str(sub.id)
  if (!scope || id === null) return null
  await reportMissingOwner(event, scope, ctx)
  const reason = obj(sub.cancellation_details)?.reason === "payment_failed" ? "unpaid" : "canceled"
  const endedAt = num(sub.ended_at)
  return { type: "subscription_ended", movement: `${ctx.rail}:${id}`, rail: ctx.rail, offerId: scope.offerId, owner: scope.owner, reason, at: endedAt !== null ? endedAt * 1000 : atOf(event) }
}

async function refund(event: StripeEventLike, ctx: TranslateContext): Promise<RailFact | null> {
  const r = event.data.object
  const status = r.status
  // A refund that may still fail is no fact yet.
  if (status === "pending" || status === "requires_action") return null
  const succeeded = status === "succeeded"
  const reversed = status === "failed" || status === "canceled"
  if (!succeeded && !reversed) {
    await ctx.unhandled(event, `refund at an unknown status '${String(status)}'`)
    return null
  }
  const id = str(r.id)
  const amount = num(r.amount)
  const pi = refId(r.payment_intent)
  if (id === null || amount === null) {
    await ctx.unhandled(event, "refund without id or amount")
    return null
  }
  if (pi === null) {
    await ctx.unhandled(event, "refund without payment_intent: no payment movement to take the credits back from")
    return null
  }
  return { type: succeeded ? "refund" : "refund_reversed", movement: `${ctx.rail}:${id}`, rail: ctx.rail, paymentMovement: `${ctx.rail}:${pi}`, amountMinor: amount, at: atOf(event) }
}

const DISPUTE_STATUS: Record<string, "opened" | "won" | "lost"> = {
  needs_response: "opened",
  under_review: "opened",
  appeal_needs_response: "opened",
  appeal_under_review: "opened",
  won: "won",
  prevented: "won",
  lost: "lost",
}

async function dispute(event: StripeEventLike, ctx: TranslateContext): Promise<RailFact | null> {
  const d = event.data.object
  const status = typeof d.status === "string" ? d.status : ""
  // An inquiry moves no money.
  if (status.startsWith("warning_")) return null
  const mapped = DISPUTE_STATUS[status]
  if (!mapped) {
    await ctx.unhandled(event, `dispute at an unknown status '${status}'`)
    return null
  }
  const id = str(d.id)
  const amount = num(d.amount)
  const currency = str(d.currency)
  const pi = refId(d.payment_intent)
  if (id === null || amount === null || currency === null || pi === null) {
    await ctx.unhandled(event, "dispute without id, amount, currency or payment_intent")
    return null
  }
  return { type: "dispute", movement: `${ctx.rail}:${id}`, rail: ctx.rail, paymentMovement: `${ctx.rail}:${pi}`, status: mapped, amountMinor: amount, currency: currency.toUpperCase(), at: atOf(event) }
}

/** The event types that may give a fact. Every other type gives null. */
export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.deleted",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
] as const

export async function eventToFact(event: StripeEventLike, ctx: TranslateContext): Promise<RailFact | null> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return checkoutPayment(event, ctx)
    case "invoice.paid":
      return invoicePaid(event, ctx)
    case "invoice.payment_failed":
      return invoiceFailed(event, ctx)
    case "customer.subscription.deleted":
      return subscriptionDeleted(event, ctx)
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
      return refund(event, ctx)
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
    case "charge.dispute.funds_withdrawn":
    case "charge.dispute.funds_reinstated":
      return dispute(event, ctx)
    default:
      return null
  }
}
