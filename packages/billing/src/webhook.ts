/**
 * From a raw webhook to the journal: verify, then dispatch the fact.
 *
 * Webhooks arrive out of order. A refund, a refund reversal or a dispute that
 * names a payment the store does not know yet is KEPT when the store can keep
 * it (`deferFact` / `takeDeferred`): the outcome is `deferred`, and the fact is
 * applied right after its payment, in the order of the facts' dates. A store
 * without those two methods keeps the old behaviour (`unknown_payment`,
 * nothing written): the host must then keep and replay such facts itself.
 */
import { accountIdFor, applyPayment, checkPayment, serial, type PaymentOutcome } from "./payment.js"
import { endSubscription, failRenewal } from "./periods.js"
import { applyDispute, applyRefund, applyRefundReversal } from "./reclaim.js"
import type { BillingDeps, BillingStateStore, DeferredFact, PeriodRecord } from "./ports.js"
import type { PaymentFact, RailFact, RenewalFailedFact, SettlementProvider, SubscriptionEndedFact, WebhookRequest } from "./settlement.js"

/** Outcome of a subscription fact. `no_period`: the offer has no open period for that owner, nothing was written. */
export type SubscriptionFactOutcome =
  | { status: "applied"; period: PeriodRecord }
  | { status: "replayed"; period: PeriodRecord }
  | { status: "no_period" }
  | { status: "refused"; reason: string }

export type FactOutcome =
  | { type: "payment"; outcome: PaymentOutcome; deferred?: FactOutcome[] }
  | {
      type: "refund"
      outcome: Awaited<ReturnType<typeof applyRefund>> | { status: "unknown_payment"; reclaimed: 0 } | { status: "deferred"; reclaimed: 0 }
    }
  | {
      type: "refund_reversed"
      outcome: Awaited<ReturnType<typeof applyRefundReversal>> | { status: "deferred"; restored: 0 }
    }
  | { type: "dispute"; outcome: Awaited<ReturnType<typeof applyDispute>> | { status: "deferred" } }
  | { type: "renewal_failed"; outcome: SubscriptionFactOutcome }
  | { type: "subscription_ended"; outcome: SubscriptionFactOutcome }
  | { type: "ignored" }

const defers = (s: BillingStateStore): boolean => typeof s.deferFact === "function" && typeof s.takeDeferred === "function"

async function applyMoneyFact(deps: BillingDeps, fact: DeferredFact, accountId: string): Promise<FactOutcome> {
  if (fact.type === "refund") return { type: "refund", outcome: await applyRefund(deps, fact, { accountId }) }
  if (fact.type === "refund_reversed") return { type: "refund_reversed", outcome: await applyRefundReversal(deps, fact, { accountId }) }
  return { type: "dispute", outcome: await applyDispute(deps, fact, { accountId }) }
}

/** A fact that names a payment: applied, kept for later, or unknown. */
async function handleMoneyFact(deps: BillingDeps, fact: DeferredFact): Promise<FactOutcome> {
  return serial(`defer:${fact.paymentMovement}`, async () => {
    const accountId = await deps.state.paymentAccount(fact.paymentMovement)
    if (accountId) return applyMoneyFact(deps, fact, accountId)
    if (defers(deps.state)) {
      await deps.state.deferFact!(fact.paymentMovement, fact)
      if (fact.type === "refund") return { type: "refund", outcome: { status: "deferred", reclaimed: 0 } }
      if (fact.type === "refund_reversed") return { type: "refund_reversed", outcome: { status: "deferred", restored: 0 } }
      return { type: "dispute", outcome: { status: "deferred" } }
    }
    if (fact.type === "refund") return { type: "refund", outcome: { status: "unknown_payment", reclaimed: 0 } }
    if (fact.type === "refund_reversed") return { type: "refund_reversed", outcome: { status: "unknown_payment", restored: 0 } }
    return { type: "dispute", outcome: { status: "unknown_payment" } }
  })
}

/** The facts kept for this payment, applied in the order of their dates, once its effect is in the journal. */
async function drainDeferred(deps: BillingDeps, payment: PaymentFact): Promise<FactOutcome[]> {
  if (!defers(deps.state)) return []
  return serial(`defer:${payment.movement}`, async () => {
    const kept = (await deps.state.takeDeferred!(payment.movement)).sort((a, b) => a.at - b.at)
    if (kept.length === 0) return []
    const accountId = await deps.state.paymentAccount(payment.movement)
    const out: FactOutcome[] = []
    for (let i = 0; i < kept.length; i++) {
      const f = kept[i]!
      try {
        // A fact dated before its payment takes effect when the payment lands.
        out.push(await applyMoneyFact(deps, { ...f, at: Math.max(f.at, payment.paidAt) }, accountId!))
      } catch (e) {
        // Keep what was not applied, so a replay of the payment applies it.
        for (const rest of kept.slice(i)) await deps.state.deferFact!(payment.movement, rest)
        throw e
      }
    }
    return out
  })
}

async function subscriptionFact(deps: BillingDeps, fact: RenewalFailedFact | SubscriptionEndedFact): Promise<SubscriptionFactOutcome> {
  let accountId: string
  try {
    accountId = accountIdFor(deps.manifest, fact.owner)
  } catch (e) {
    return { status: "refused", reason: (e as Error).message }
  }
  const periods = (await deps.state.listPeriods({ accountId, offerId: fact.offerId })).sort((a, b) => b.endAt - a.endAt)
  if (fact.type === "renewal_failed") {
    if (periods.some(p => p.status === "active")) {
      const p = await failRenewal(deps, { accountId, offerId: fact.offerId, at: fact.at })
      return { status: "applied", period: p! }
    }
    const due = periods.find(p => p.status === "past_due")
    return due ? { status: "replayed", period: due } : { status: "no_period" }
  }
  const ended = await endSubscription(deps, { accountId, offerId: fact.offerId, reason: fact.reason, at: fact.at })
  if (ended) return { status: "applied", period: ended }
  const done = periods.find(p => p.status === "closed" && (p.closedReason === "canceled" || p.closedReason === "unpaid"))
  return done ? { status: "replayed", period: done } : { status: "no_period" }
}

/** Apply an already verified fact. */
export async function handleRailFact(deps: BillingDeps, fact: RailFact): Promise<FactOutcome> {
  if (fact.type === "payment") {
    const outcome = await applyPayment(deps, fact)
    // The effect is in the journal: applied now, or a valid fact replayed.
    const effect = outcome.status === "applied" || (outcome.status === "replayed" && checkPayment(deps.manifest, fact).ok)
    const deferred = effect ? await drainDeferred(deps, fact) : []
    return { type: "payment", outcome, ...(deferred.length > 0 ? { deferred } : {}) }
  }
  if (fact.type === "renewal_failed") return { type: "renewal_failed", outcome: await subscriptionFact(deps, fact) }
  if (fact.type === "subscription_ended") return { type: "subscription_ended", outcome: await subscriptionFact(deps, fact) }
  return handleMoneyFact(deps, fact)
}

/** Rule 1: a webhook whose signature fails throws here and nothing is written. */
export async function handleWebhook(deps: BillingDeps, provider: SettlementProvider, raw: WebhookRequest): Promise<FactOutcome> {
  const fact = await provider.verifyWebhook(raw)
  if (!fact) return { type: "ignored" }
  return handleRailFact(deps, fact)
}
