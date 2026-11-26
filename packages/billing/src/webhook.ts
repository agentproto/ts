/** From a raw webhook to the journal: verify, then dispatch the fact. */
import { applyPayment, type PaymentOutcome } from "./payment.js"
import { applyDispute, applyRefund, applyRefundReversal } from "./reclaim.js"
import type { BillingDeps } from "./ports.js"
import type { RailFact, SettlementProvider, WebhookRequest } from "./settlement.js"

export type FactOutcome =
  | { type: "payment"; outcome: PaymentOutcome }
  | { type: "refund"; outcome: Awaited<ReturnType<typeof applyRefund>> | { status: "unknown_payment"; reclaimed: 0 } }
  | { type: "refund_reversed"; outcome: Awaited<ReturnType<typeof applyRefundReversal>> }
  | { type: "dispute"; outcome: Awaited<ReturnType<typeof applyDispute>> }
  | { type: "ignored" }

/** Apply an already verified fact. */
export async function handleRailFact(deps: BillingDeps, fact: RailFact): Promise<FactOutcome> {
  if (fact.type === "payment") return { type: "payment", outcome: await applyPayment(deps, fact) }
  const accountId = await deps.state.paymentAccount(fact.paymentMovement)
  if (!accountId) {
    if (fact.type === "refund") return { type: "refund", outcome: { status: "unknown_payment", reclaimed: 0 } }
    if (fact.type === "refund_reversed") return { type: "refund_reversed", outcome: { status: "unknown_payment", restored: 0 } }
    return { type: "dispute", outcome: { status: "unknown_payment" } }
  }
  if (fact.type === "refund") return { type: "refund", outcome: await applyRefund(deps, fact, { accountId }) }
  if (fact.type === "refund_reversed") return { type: "refund_reversed", outcome: await applyRefundReversal(deps, fact, { accountId }) }
  return { type: "dispute", outcome: await applyDispute(deps, fact, { accountId }) }
}

/** Rule 1: a webhook whose signature fails throws here and nothing is written. */
export async function handleWebhook(deps: BillingDeps, provider: SettlementProvider, raw: WebhookRequest): Promise<FactOutcome> {
  const fact = await provider.verifyWebhook(raw)
  if (!fact) return { type: "ignored" }
  return handleRailFact(deps, fact)
}
