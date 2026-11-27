/**
 * The calls this adapter makes to Stripe besides the webhook reads: checkout,
 * billing portal, refund, and the account check of `check()`. Every refusal
 * that can be decided locally (a return URL, a missing owner key, a bound, a
 * movement that is not a payment intent) is decided BEFORE any call.
 */
import { assertReturnUrl, type CheckoutOutcome, type CheckoutRequest, type PortalRequest, type SettlementProvider } from "@agentproto/billing"
import { priceMatches, type StripeCatalog, type StripeTaxBehavior } from "./catalog.js"
import type { StripeCheckoutSessionCreateParamsLike, StripeLike } from "./client.js"
import { OFFER_KEY, OWNER_KEY_PREFIX } from "./translate.js"

type SettlementResult = Awaited<ReturnType<SettlementProvider["charge"]>>

/** Stripe's longest metadata value. */
const MAX_METADATA_VALUE = 500

/**
 * A Stripe error as text without any credential: the error code and message,
 * with every given secret and anything shaped like a Stripe key or signing
 * secret masked. Never the raw error object (its `raw` and `headers` may
 * carry request data).
 */
export function safeStripeError(e: unknown, secrets: readonly string[]): string {
  const err = (e ?? {}) as { code?: unknown; type?: unknown; name?: unknown; message?: unknown }
  const kind = [err.type, err.code].filter((v): v is string => typeof v === "string" && v !== "").join("/") || (typeof err.name === "string" ? err.name : "error")
  let text = `${kind}: ${typeof err.message === "string" ? err.message : String(e)}`
  for (const s of secrets) if (s.length >= 8) text = text.split(s).join("[redacted]")
  text = text.replace(/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9*]+/g, "[redacted key]").replace(/\bwhsec_[A-Za-z0-9*]+/g, "[redacted secret]")
  return text.length > 300 ? `${text.slice(0, 300)}...` : text
}

export interface CallContext {
  rail: string
  client: StripeLike
  catalog: () => StripeCatalog
  ownerKeys: readonly string[]
  allowedReturnOrigins: readonly string[]
  offerNamespace?: string
  automaticTax?: { taxBehavior: StripeTaxBehavior }
  secrets: () => readonly string[]
}

/** The metadata that ties a payment back to its offer and payer: `agentproto_offer` and every `agentproto_owner_<key>`. Throws on a missing key. */
export function checkoutMetadata(req: { offerId: string; owner: Record<string, string> }, ownerKeys: readonly string[]): Record<string, string> {
  const md: Record<string, string> = { [OFFER_KEY]: req.offerId }
  for (const k of ownerKeys) {
    const v = req.owner?.[k]
    if (typeof v !== "string" || v === "") throw new Error(`stripe checkout: owner key '${k}' is missing: the payment could not be tied to an account`)
    if (v.length > MAX_METADATA_VALUE) throw new Error(`stripe checkout: owner key '${k}' is longer than Stripe's ${MAX_METADATA_VALUE} characters`)
    md[`${OWNER_KEY_PREFIX}${k}`] = v
  }
  return md
}

export async function createStripeCheckout(ctx: CallContext, req: CheckoutRequest): Promise<CheckoutOutcome> {
  // Everything that can be refused is refused before the first call.
  assertReturnUrl(req.successUrl, ctx.allowedReturnOrigins)
  assertReturnUrl(req.cancelUrl, ctx.allowedReturnOrigins)
  const metadata = checkoutMetadata(req, ctx.ownerKeys)
  if (ctx.offerNamespace !== undefined && !req.offerId.startsWith(ctx.offerNamespace)) {
    throw new Error(`stripe checkout: offer '${req.offerId}' is outside offerNamespace '${ctx.offerNamespace}': its payment would give no fact`)
  }
  const offer = ctx.catalog().offers.find(o => o.offerId === req.offerId)
  if (!offer) throw new Error(`stripe checkout: offer '${req.offerId}' is not sold on rail '${ctx.catalog().rail}'`)
  if (req.quantity !== undefined && req.quantity !== 1) throw new Error(`stripe checkout: quantity ${req.quantity} refused: one payment buys one offer`)
  if (offer.trialProblem !== undefined) throw new Error(`stripe checkout: offer '${offer.offerId}' has a trial Stripe cannot carry (${offer.trialProblem})`)

  let lineItem: StripeCheckoutSessionCreateParamsLike["line_items"][number]
  if (offer.buyer) {
    const b = offer.buyer
    const amount = req.amountMinor
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1) throw new Error(`stripe checkout: offer '${offer.offerId}' needs an amountMinor chosen by the buyer`)
    if (b.minMinor !== undefined && amount < b.minMinor) throw new Error(`stripe checkout: amount ${amount} is below the offer's minimum ${b.minMinor}`)
    if (b.maxMinor !== undefined && amount > b.maxMinor) throw new Error(`stripe checkout: amount ${amount} is above the offer's maximum ${b.maxMinor}`)
    if (req.currency !== undefined && req.currency.toLowerCase() !== b.currency) throw new Error(`stripe checkout: currency '${req.currency}' is not the offer's '${b.currency.toUpperCase()}'`)
    lineItem = {
      quantity: 1,
      price_data: {
        currency: b.currency,
        unit_amount: amount,
        product_data: { name: offer.product.name, metadata: offer.product.metadata },
        ...(ctx.automaticTax ? { tax_behavior: ctx.automaticTax.taxBehavior } : {}),
      },
    }
  } else {
    const want = offer.price!
    if (req.amountMinor !== undefined && req.amountMinor !== want.unitAmount) throw new Error(`stripe checkout: offer '${offer.offerId}' has a fixed price of ${want.unitAmount}`)
    // Stripe checks the price, not the manifest: refuse a catalog that drifted rather than sell at another price.
    const found = (await ctx.client.prices.list({ lookup_keys: [want.lookupKey], limit: 1 })).data[0]
    if (!found || !priceMatches(found, want)) throw new Error(`stripe checkout: the price with lookup key '${want.lookupKey}' is missing or differs from the manifest: run syncCatalog`)
    lineItem = { price: found.id, quantity: 1 }
  }

  const params: StripeCheckoutSessionCreateParamsLike = {
    mode: offer.mode,
    success_url: req.successUrl,
    cancel_url: req.cancelUrl,
    line_items: [lineItem],
    metadata,
    ...(req.accountId ? { client_reference_id: req.accountId.slice(0, 200) } : {}),
    ...(req.payer?.ref ? { customer: req.payer.ref } : req.payer?.email ? { customer_email: req.payer.email } : {}),
    ...(offer.allowPromotionCodes ? { allow_promotion_codes: true } : {}),
    ...(ctx.automaticTax ? { automatic_tax: { enabled: true } } : {}),
  }
  if (offer.mode === "subscription") {
    // The invoices of the subscription carry these, and they are where its payments are read from.
    params.subscription_data = { metadata: { ...metadata }, ...(offer.trialDays !== undefined ? { trial_period_days: offer.trialDays } : {}) }
  }
  const session = await ctx.client.checkout.sessions.create(params)
  if (typeof session.url !== "string" || session.url === "") throw new Error(`stripe checkout: session ${session.id} has no url`)
  return { outcome: "redirect", url: session.url, ref: session.id }
}

export async function createStripePortalSession(ctx: CallContext, req: PortalRequest): Promise<{ url: string }> {
  assertReturnUrl(req.returnUrl, ctx.allowedReturnOrigins)
  const customer = req.payer?.ref
  if (typeof customer !== "string" || customer === "") throw new Error("stripe portal: payer.ref (the Stripe customer id) is required")
  const s = await ctx.client.billingPortal.sessions.create({ customer, return_url: req.returnUrl })
  return { url: s.url }
}

const PAYMENT_INTENT_MOVEMENT = /^stripe:(pi_[A-Za-z0-9_]+)$/

/**
 * Refund part or all of a payment. `ref` is the idempotency key: the same ref
 * twice is one refund at Stripe. A refusal by Stripe (more than what is left,
 * say) comes back as `{ ok: false, error }`, without any secret.
 */
export async function refundStripePayment(ctx: CallContext, movement: string, amountMinor: number, ref: string): Promise<SettlementResult> {
  const m = PAYMENT_INTENT_MOVEMENT.exec(movement)
  if (!m) return { ok: false, error: `stripe refund: movement '${movement}' is not a payment intent (stripe:pi_...)` }
  if (!Number.isInteger(amountMinor) || amountMinor < 1) return { ok: false, error: `stripe refund: amount ${amountMinor} is not a positive integer` }
  if (typeof ref !== "string" || ref === "") return { ok: false, error: "stripe refund: a ref is required (it is the idempotency key)" }
  try {
    const r = await ctx.client.refunds.create({ payment_intent: m[1]!, amount: amountMinor, metadata: { agentproto_ref: ref.slice(0, MAX_METADATA_VALUE) } }, { idempotencyKey: ref })
    return { ok: true, externalRef: `${ctx.rail}:${r.id}`, network: ctx.rail }
  } catch (e) {
    return { ok: false, error: `stripe refund: ${safeStripeError(e, ctx.secrets())}` }
  }
}

/** The account the key belongs to, against the one expected: null when it matches, else the reason. */
export async function accountProblem(ctx: CallContext, expected: string): Promise<string | null> {
  let id: string
  try {
    id = (await ctx.client.accounts.retrieveCurrent()).id
  } catch (e) {
    return `rail '${ctx.rail}': the key cannot read its account (${safeStripeError(e, ctx.secrets())}); a restricted key needs read access to the account`
  }
  return id === expected ? null : `rail '${ctx.rail}': the key belongs to account '${id}', not to the expected '${expected}'`
}
