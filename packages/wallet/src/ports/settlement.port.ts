/**
 * SettlementPort — the only bridge between the internal journal and the outside.
 *
 * Resolved PER ASSET (`AssetRuleSet.settleOut` names the network). Inbound and
 * outbound never share a write with a journal event: a confirmed external fact
 * (proof) is recorded, THEN it mints/burns internally. Outbound rides the
 * hold→pay→capture/release two-phase commit so internal value is never burned
 * before the external leg confirms.
 *
 * Stripe, PawaPay, x402 and Solana are all adapters behind this one interface.
 */

import type { AssetRef } from "../asset.js"

export interface SettlementResult {
  ok: boolean
  /** External proof reference (Stripe payment_intent, tx signature, x402 receipt). */
  externalRef?: string
  /** Network the value moved on. */
  network?: string
  error?: string
}

export interface SettlementPort {
  /** Inbound: pull funds from an external rail (→ mint on confirmation). */
  charge(params: {
    accountId: string
    /** Amount in the asset's minor units. */
    amountMinor: number
    asset: AssetRef
    /** Idempotency reference (offerId, invoiceId, …). */
    ref: string
  }): Promise<SettlementResult>

  /** Outbound: push value to a counterparty (the active/discretionary path). */
  pay(params: {
    counterparty: string
    amountMinor: number
    asset: AssetRef
    /** Optional pre-obtained proof (e.g. x402 receipt) to replay. */
    proof?: string
  }): Promise<SettlementResult>
}
