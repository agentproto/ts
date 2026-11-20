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
  amountMinor: number
  /** Tax included in `amountMinor`, 0 when unknown. */
  taxMinor: number
  currency: string
  /** Epoch ms of the payment. */
  paidAt: number
}

/** A verified refund of money. */
export interface RefundFact {
  type: "refund"
  /** `stripe:re_...` */
  movement: string
  rail: string
  /** The payment movement it refunds. */
  paymentMovement: string
  amountMinor: number
  at: number
}

/** A verified dispute event. */
export interface DisputeFact {
  type: "dispute"
  /** `stripe:du_...` */
  movement: string
  rail: string
  paymentMovement: string
  status: "opened" | "won" | "lost"
  at: number
}

export type RailFact = PaymentFact | RefundFact | DisputeFact

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
  /** Give money back, at most what was paid. Optional: a rail may not refund. */
  refund?(movement: string, amountMinor: number): Promise<SettlementResult>
  /** Push the catalog projection to the provider. Optional. */
  syncCatalog?(projection: unknown): Promise<void>
}

/** Default variable names of a rail: `<RAIL>_SECRET_KEY`, `<RAIL>_WEBHOOK_SECRET`, `<RAIL>_MODE`. */
export function defaultRailEnv(railId: string): { secretKey: string; webhookSecret: string; mode: string } {
  const up = railId.toUpperCase().replace(/-/g, "_")
  return { secretKey: `${up}_SECRET_KEY`, webhookSecret: `${up}_WEBHOOK_SECRET`, mode: `${up}_MODE` }
}
