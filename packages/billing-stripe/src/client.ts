/**
 * The part of a Stripe client this adapter calls, as a structural type. The
 * real SDK (`new Stripe(key)`) satisfies it (a type test checks so), and a test
 * double can stand in for it without any network.
 */

/** An id field Stripe may return as a string or, when expanded, as the object. */
export type StripeRef = string | { id: string }

/** One payment of an invoice (`InvoicePayment`). */
export interface StripeInvoicePaymentLike {
  id: string
  amount_paid: number | null
  currency: string
  status: string
  payment: { type: string; payment_intent?: StripeRef }
}

export interface StripeListLike<T> {
  data: T[]
  has_more: boolean
}

/** The request options this adapter passes: only the idempotency key. */
export interface StripeRequestOptionsLike {
  idempotencyKey?: string
}

/** A price, as far as the catalog sync and the checkout read it. */
export interface StripePriceLike {
  id: string
  active: boolean
  currency: string
  unit_amount: number | null
  lookup_key: string | null
  product: StripeRef
  recurring: { interval: string; interval_count: number } | null
  tax_behavior?: string | null
  metadata?: Record<string, string>
}

/** A product, as far as the catalog sync reads it. */
export interface StripeProductLike {
  id: string
  name: string
  active: boolean
  metadata: Record<string, string>
}

export interface StripePriceCreateParamsLike {
  product: string
  currency: string
  unit_amount: number
  lookup_key: string
  transfer_lookup_key: boolean
  recurring?: { interval: "day" | "week" | "month" | "year"; interval_count?: number }
  tax_behavior?: "inclusive" | "exclusive"
  metadata: Record<string, string>
}

export interface StripeProductCreateParamsLike {
  id: string
  name: string
  metadata: Record<string, string>
}

/** The parameters of a Checkout Session this adapter sets. */
export interface StripeCheckoutSessionCreateParamsLike {
  mode: "payment" | "subscription"
  success_url: string
  cancel_url: string
  line_items: (
    | { price: string; quantity: number }
    | {
        quantity: number
        price_data: {
          currency: string
          unit_amount: number
          product_data: { name: string; metadata: Record<string, string> }
          tax_behavior?: "inclusive" | "exclusive"
        }
      }
  )[]
  metadata: Record<string, string>
  client_reference_id?: string
  customer?: string
  customer_email?: string
  allow_promotion_codes?: boolean
  automatic_tax?: { enabled: boolean }
  subscription_data?: { metadata: Record<string, string>; trial_period_days?: number }
}

/**
 * The part of the Stripe API this adapter calls. Reads: `invoicePayments.list`
 * (webhooks), `accounts.retrieveCurrent` (`check()`), `products.list` and
 * `prices.list` (catalog, checkout). Writes: `refunds.create`,
 * `checkout.sessions.create`, `billingPortal.sessions.create`,
 * `products.create`, `products.update`, `prices.create`. Nothing else, and
 * never a delete.
 */
export interface StripeLike {
  invoicePayments: {
    list(params: { invoice?: string; status?: string; limit?: number }): PromiseLike<StripeListLike<StripeInvoicePaymentLike>>
  }
  accounts: {
    retrieveCurrent(): PromiseLike<{ id: string }>
  }
  refunds: {
    create(params: { payment_intent: string; amount: number; metadata?: Record<string, string> }, options?: StripeRequestOptionsLike): PromiseLike<{ id: string; status: string | null }>
  }
  checkout: {
    sessions: {
      create(params: StripeCheckoutSessionCreateParamsLike, options?: StripeRequestOptionsLike): PromiseLike<{ id: string; url: string | null }>
    }
  }
  billingPortal: {
    sessions: {
      create(params: { customer: string; return_url: string }, options?: StripeRequestOptionsLike): PromiseLike<{ url: string }>
    }
  }
  products: {
    list(params: { ids?: string[]; limit?: number }): PromiseLike<StripeListLike<StripeProductLike>>
    create(params: StripeProductCreateParamsLike, options?: StripeRequestOptionsLike): PromiseLike<StripeProductLike>
    update(id: string, params: { name?: string; active?: boolean; metadata?: Record<string, string> }, options?: StripeRequestOptionsLike): PromiseLike<StripeProductLike>
  }
  prices: {
    list(params: { lookup_keys?: string[]; limit?: number }): PromiseLike<StripeListLike<StripePriceLike>>
    create(params: StripePriceCreateParamsLike, options?: StripeRequestOptionsLike): PromiseLike<StripePriceLike>
  }
}

/** A Stripe webhook event, as far as this adapter reads it. */
export interface StripeEventLike {
  id: string
  object?: string
  type: string
  api_version: string | null
  created: number
  livemode: boolean
  data: { object: Record<string, unknown> }
}

/** The id of a field that may be a string or an expanded object. */
export function refId(v: unknown): string | null {
  if (typeof v === "string" && v !== "") return v
  if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") return (v as { id: string }).id
  return null
}
