/**
 * `SettlementProvider`: the payment provider contract of AIP-74. It extends the
 * AIP-49 `SettlementPort` (`charge`, `pay`) with what a payment path needs.
 * There is no second settlement interface: this one IS the port plus webhook
 * verification, declared capabilities, and optional refund, checkout, portal
 * and catalog sync.
 *
 * `BillingRail` (AIP-55) is something else: the projection config on a product.
 */
import type { SettlementPort } from "@agentproto/wallet/ports"
import type { SettlementResult } from "@agentproto/wallet/ports"
import type { BillingHandle } from "./define-billing-manifest.js"

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
  /**
   * Set when the rail cannot tie this money to one offer and one payer (an
   * invoice settled by several payments, say): the reason. The core refuses
   * the fact with that reason, so the money is minted alone and listed as
   * owed (rule 4), and no credit is given.
   */
  unsupported?: string
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

/** A subscription renewal that failed at the rail: the open period of the offer goes `past_due` for its grace. */
export interface RenewalFailedFact {
  type: "renewal_failed"
  /** The rail id of the failed attempt (an invoice, say). */
  movement: string
  rail: string
  offerId: string
  owner: Record<string, string>
  at: number
}

/** A subscription that ended at the rail (canceled, or ended unpaid): its open period closes at `at`. */
export interface SubscriptionEndedFact {
  type: "subscription_ended"
  /** The rail id of the subscription. */
  movement: string
  rail: string
  offerId: string
  owner: Record<string, string>
  reason: "canceled" | "unpaid"
  at: number
}

export type RailFact = PaymentFact | RefundFact | RefundReversedFact | DisputeFact | RenewalFailedFact | SubscriptionEndedFact

export interface WebhookRequest {
  body: string
  headers: Record<string, string>
}

/**
 * What a rail can do, declared by its provider and read at start-up
 * (`assertRailCapabilities`) and by the registry listing. A flag is honest:
 * `true` means the matching method exists and works, `false` means it is
 * absent or answers `unsupported` (SET-6).
 */
export interface SettlementCapabilities {
  /** One-time payments (`one-time` and `prepaid-pool` offers). */
  oneTimePayments: boolean
  /** An amount the buyer chooses (`amountMinor: buyer`). */
  buyerAmount: boolean
  subscriptions: boolean
  /** A free trial before the first paid period (`subscription.trial`). */
  trials: boolean
  /** Coupons and promotion codes (`discounts: allow`). */
  discounts: boolean
  /** Who emits the money facts of this rail: itself, another provider (`moneyFactsFrom`), or none. */
  moneyFacts: "self" | "delegated" | "none"
  /** With `moneyFacts: "delegated"`: the id of the provider that emits them and runs the refunds. */
  moneyFactsFrom?: string
  refunds: "none" | "full" | "partial"
  /** Emits `refund_reversed` when a succeeded refund fails or is canceled. */
  refundReversals: boolean
  /** Emits `dispute` facts with their amount. */
  disputes: boolean
  checkout: boolean
  portal: boolean
  catalogSync: boolean
  /** `charge()` takes money without the payer present. */
  offSessionCharge: boolean
  /** `pay()` sends money out. */
  payouts: boolean
  /** `taxMinor` of its payment facts is the tax the rail computed. */
  taxReported: boolean
  /** Where the balance of record lives: the AIP-49 journal, or the provider. */
  balanceAuthority: "journal" | "provider"
  /** The provider holds credits on its side (a remote reservation). */
  remoteHolds: boolean
}

/** Who pays, as the rail knows them. Absent from the offer and the owner keys. */
export interface CheckoutPayer {
  /** The payer's id at the rail (a customer id), when the host keeps one. */
  ref?: string
  email?: string
}

/** A checkout of one offer. Nothing is written by a checkout: only the verified webhook writes (rule 1). */
export interface CheckoutRequest {
  offerId: string
  /** The server-side owner keys (rule 20): the provider carries them to the payment fact. */
  owner: Record<string, string>
  accountId: string
  successUrl: string
  cancelUrl: string
  quantity?: number
  /** For an offer with `amountMinor: buyer`. */
  amountMinor?: number
  currency?: string
  payer?: CheckoutPayer
}

export type CheckoutOutcome =
  /** The payer goes to `url` to pay. */
  | { outcome: "redirect"; url: string; ref: string }
  /** Charged at once with a saved method; the money fact still comes by webhook. */
  | { outcome: "charged"; ref: string; invoiceRef: string }
  /** An invoice was sent to the payer. */
  | { outcome: "invoice_sent"; ref: string; invoiceRef: string }
  /** Nothing to pay now (a trial, a zero total). */
  | { outcome: "no_payment"; ref: string }

export interface PortalRequest {
  owner: Record<string, string>
  accountId: string
  returnUrl: string
  payer?: CheckoutPayer
}

/** One part of the manifest the rail cannot carry: named, never dropped in silence. */
export interface CatalogDegradation {
  offerId: string
  /** The manifest field (`subscription.anchor`, `conversion.bonus`, ...). */
  field: string
  reason: string
}

/** What a catalog sync did, or would do with `dryRun`. The lists hold offer ids. */
export interface CatalogSyncReport {
  created: string[]
  updated: string[]
  unchanged: string[]
  degradations: CatalogDegradation[]
}

export interface SettlementProvider extends SettlementPort {
  /** The rail id this provider settles. */
  readonly id: string
  readonly name: string
  /** Variable NAMES the provider reads, never values (AIP-74 Adapters). */
  readonly env: { secretKey: string; webhookSecret: string; mode: string }
  /** What the rail can do. Required: a start-up check reads it (`assertRailCapabilities`). */
  readonly capabilities: SettlementCapabilities
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
  /** Is the provider set up (key present, of the right mode, the expected account)? Read by the registry; absent means yes. */
  check?(): Promise<{ ok: boolean; reason?: string }>
  /** Start a checkout of an offer. Return URLs are checked before any call (`assertReturnUrl`). */
  createCheckout?(req: CheckoutRequest): Promise<CheckoutOutcome>
  /** A session of the rail's billing portal. */
  createPortalSession?(req: PortalRequest): Promise<{ url: string }>
  /** Project the manifest's offers onto the rail's catalog. Never deletes at the rail. `dryRun` only reads. */
  syncCatalog?(manifest: BillingHandle, opts?: { dryRun?: boolean }): Promise<CatalogSyncReport>
}

/** Default variable names of a rail: `<RAIL>_SECRET_KEY`, `<RAIL>_WEBHOOK_SECRET`, `<RAIL>_MODE`. */
export function defaultRailEnv(railId: string): { secretKey: string; webhookSecret: string; mode: string } {
  const up = railId.toUpperCase().replace(/-/g, "_")
  return { secretKey: `${up}_SECRET_KEY`, webhookSecret: `${up}_WEBHOOK_SECRET`, mode: `${up}_MODE` }
}
