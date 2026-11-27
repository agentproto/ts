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

export interface StripeLike {
  invoicePayments: {
    list(params: { invoice?: string; status?: string; limit?: number }): PromiseLike<StripeListLike<StripeInvoicePaymentLike>>
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
