/**
 * `SettlementProvider`: the payment provider contract of AIP-74. It extends the
 * AIP-49 `SettlementPort` (`charge`, `pay`) with what a payment path needs.
 * There is no second settlement interface: this one IS the port plus webhook
 * verification, an optional refund and an optional catalog push.
 *
 * `BillingRail` (AIP-55) is something else: the projection config on a product.
 */
import type { SettlementPort } from "@agentproto/wallet/ports"
import type { SettlementResult } from "@agentproto/wallet/ports"

/** A verified payment. `movement` is the identity of the MONEY movement (rule 2). */
export interface PaymentFact {
  type: "payment"
  /** Normalised per rail (`stripe:pi_...`), never an event id. */
  movement: string
  rail: string
  offerId: string
  /** Server-side context keys of the payer (rule 20), named by `payer.owner`. */
  owner: Record<string, string>
  /** What the payer paid, tax included whatever `taxBehavior` says. */
  amountMinor: number
  /** Tax inside `amountMinor`, 0 when unknown. */
  taxMinor: number
  /**
   * `inclusive` (default): the price already holds the tax, so `amountMinor`
   * equals the price. `exclusive`: the tax was added on top of the price, so
   * `amountMinor - taxMinor` equals the price.
   */
  taxBehavior?: "inclusive" | "exclusive"
  /**
   * Discount granted by the rail (coupon, promotion code), 0 by default. Only
   * accepted on an offer with `discounts: allow`; the price is then the paid
   * amount (net of an exclusive tax) plus the discount.
   */
  discountMinor?: number
  currency: string
  /** Epoch ms of the payment. */
  paidAt: number
}

/**
 * A verified refund of money. A rail emits it once the refund has SUCCEEDED,
 * never at its creation: a refund that is still pending may fail.
 */
export interface RefundFact {
  type: "refund"
  /** The rail id of the refund, as the rail gives it (`stripe:re_...`). */
  movement: string
  rail: string
  /** The payment movement it refunds. */
  paymentMovement: string
  /** This refund alone, never a cumulative amount of the payment. */
  amountMinor: number
  at: number
}

/**
 * A refund that had succeeded and then failed or was canceled: the money came
 * back to the merchant, so the credits the refund took are given back.
 */
export interface RefundReversedFact {
  type: "refund_reversed"
  /** The movement of the refund that is reversed (`stripe:re_...`). */
  movement: string
  rail: string
  paymentMovement: string
  amountMinor: number
  at: number
}

/**
 * A verified dispute event, about money that is (or may be) taken back by the
 * payer's bank. An inquiry that moves no money (Stripe `warning_*` statuses)
 * is NOT a dispute: a rail returns no fact for it.
 */
export interface DisputeFact {
  type: "dispute"
  /** The rail id of the dispute, kept as the rail gives it (`stripe:dp_...`); no prefix is checked. */
  movement: string
  rail: string
  paymentMovement: string
  status: "opened" | "won" | "lost"
  /** Disputed amount. It may be part of the payment. */
  amountMinor: number
  /** Currency of `amountMinor`. When it differs from the payment's, the whole payment is taken as disputed. */
  currency: string
  at: number
}

export type RailFact = PaymentFact | RefundFact | RefundReversedFact | DisputeFact

export interface WebhookRequest {
  body: string
  headers: Record<string, string>
}

export interface SettlementProvider extends SettlementPort {
  /** The rail id this provider settles. */
  readonly id: string
  readonly name: string
  /** Variable NAMES the provider reads, never values (AIP-74 Adapters). */
  readonly env: { secretKey: string; webhookSecret: string; mode: string }
  /**
   * Verify the signature and turn a webhook into a fact, or return null for an
   * event that is about no money movement. Throws when the signature is wrong:
   * nothing is written before the verified fact (rule 1).
   */
  verifyWebhook(raw: WebhookRequest): Promise<RailFact | null>
  /**
   * Give money back, at most what was paid. Optional: a rail may not refund.
   * `ref` is the caller's reference of this refund and the idempotency key at
   * the rail: two refunds of the same amount on one payment carry two refs and
   * are two refunds; the same ref twice is one refund.
   */
  refund?(movement: string, amountMinor: number, ref: string): Promise<SettlementResult>
  /** Push the catalog projection to the provider. Optional. */
  syncCatalog?(projection: unknown): Promise<void>
}

/** Default variable names of a rail: `<RAIL>_SECRET_KEY`, `<RAIL>_WEBHOOK_SECRET`, `<RAIL>_MODE`. */
export function defaultRailEnv(railId: string): { secretKey: string; webhookSecret: string; mode: string } {
  const up = railId.toUpperCase().replace(/-/g, "_")
  return { secretKey: `${up}_SECRET_KEY`, webhookSecret: `${up}_WEBHOOK_SECRET`, mode: `${up}_MODE` }
}
