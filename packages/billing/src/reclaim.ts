/**
 * Refunds and disputes (AIP-74 rules 6 to 8).
 *
 * The money refund is the merchant's decision and the rail's act. The journal
 * only takes back credits, and never more than: the share of the payment that
 * was taken back times what the payment minted, what is still unreserved and
 * unexpired in the lots it minted, and never the bonus (rule 12).
 *
 * The share is CUMULATIVE per payment: every refund and every lost dispute of
 * one payment adds its amount, capped at what was paid, so two partial refunds
 * of the same amount are two refunds and a duplicate never takes more than the
 * payment. The subscription period of the payment closes only once the share
 * reaches the whole payment (rule 7). A refund that is reversed, or a dispute
 * won after it was lost, gives back what it took and lowers the share again.
 *
 * Every refund and lost dispute leaves a zero-amount marker on the payment's
 * fiat lot: `<movement>:refund:<amountMinor>` or `<movement>:lost:<amountMinor>`,
 * with `correlationId` = the payment movement. The share is read from them, so
 * the journal alone answers what was taken back of a payment (rule 5).
 */
import { fold, type Lot } from "@agentproto/wallet"
import { serial } from "./payment.js"
import { closePeriod, reopenPeriod } from "./periods.js"
import type { BillingDeps, CauseEvent } from "./ports.js"
import { normalizeCurrency, normalizeRef } from "./model.js"
import type { DisputeFact, RefundFact, RefundReversedFact } from "./settlement.js"

export interface Minted {
  accountId: string
  paid: number
  /** The lots credits can be taken back from. */
  lots: Lot[]
  /** What the payment minted, the base of the share. Defaults to the sum of `original` of `lots`. */
  total?: number
}

const ORIGIN_REFUND = "refund"
const ORIGIN_REFUND_REVERSED = "refund-reversed"
const ORIGIN_DISPUTE_LOST = "dispute-lost"
const ORIGIN_DISPUTE_REINSTATED = "dispute-reinstated"

/**
 * The non-bonus credit lots a payment minted, plus the lots a reversal gave
 * back to it, and what it paid. Null when the payment is unknown.
 */
function mintedFrom(events: CauseEvent[], primaryAsset: string, accountId: string, paymentMovement: string, now: number): Minted | null {
  const fiat = events.find(e => e.id === `${paymentMovement}:fiat`)
  if (!fiat) return null
  const byId = new Map(events.map(e => [e.id, e]))
  const all = fold(events, now).filter(l => l.asset === primaryAsset)
  const own = all.filter(l => {
    const src = byId.get(l.sourceEventId)
    return src?.cause === paymentMovement && src.origin !== "bonus"
  })
  const givenBack = all.filter(l => {
    const src = byId.get(l.sourceEventId)
    return (src?.origin === ORIGIN_REFUND_REVERSED || src?.origin === ORIGIN_DISPUTE_REINSTATED) && src.correlationId === paymentMovement
  })
  return { accountId, paid: fiat.amount, lots: [...own, ...givenBack], total: own.reduce((s, l) => s + l.original, 0) }
}

const live = (l: Lot, now: number): number =>
  l.expiresAt !== undefined && l.expiresAt <= now ? 0 : Math.max(0, l.remaining - l.reserved)

const EPS = 1e-9

/** Credits the slice `fromMinor..toMinor` of the payment stands for, taken newest lot first, capped at what is live. */
function planShare(minted: Minted, fromMinor: number, toMinor: number, now: number): { lotId: string; amount: number }[] {
  const total = minted.total ?? minted.lots.reduce((s, l) => s + l.original, 0)
  const at = (minor: number) => (minted.paid > 0 ? Math.floor((Math.min(minted.paid, minor) * total) / minted.paid + EPS) : 0)
  let budget = Math.min(Math.max(0, at(toMinor) - at(fromMinor)), minted.lots.reduce((s, l) => s + live(l, now), 0))
  const out: { lotId: string; amount: number }[] = []
  for (const l of [...minted.lots].sort((a, b) => b.createdAt - a.createdAt)) {
    if (budget <= 0) break
    const take = Math.min(budget, live(l, now))
    if (take > 0) out.push({ lotId: l.id, amount: take })
    budget -= take
  }
  return out
}

/** Rule 6. Pure. The lots to burn and by how much, newest lot first, for one refund taken alone. */
export function planReclaim(minted: Minted, refundedMinor: number, now: number): { lotId: string; amount: number }[] {
  return planShare(minted, 0, refundedMinor, now)
}

/** Money of a payment taken back by its refunds and lost disputes that still stand, in minor units. Pure. */
export function takenBackMinor(events: readonly CauseEvent[], paymentMovement: string): number {
  const ids = new Set(events.map(e => e.id))
  let sum = 0
  for (const e of events) {
    if (e.correlationId !== paymentMovement) continue
    const refund = e.origin === ORIGIN_REFUND ? /^(.*):refund:(\d+)$/.exec(e.id) : null
    if (refund && !ids.has(`${refund[1]}:reversed`)) sum += Number(refund[2])
    const lost = e.origin === ORIGIN_DISPUTE_LOST ? /^(.*):lost:(\d+)$/.exec(e.id) : null
    if (lost && !ids.has(`${lost[1]}:reinstated`)) sum += Number(lost[2])
  }
  return sum
}

/** A zero-amount marker on the payment's fiat lot. */
const marker = (fiat: CauseEvent, id: string, cause: string, paymentMovement: string, origin: string, at: number): CauseEvent => ({
  id,
  accountId: fiat.accountId,
  kind: "burn",
  asset: fiat.asset,
  partitionId: fiat.partitionId,
  restriction: [],
  amount: 0,
  lotId: fiat.lotId,
  correlationId: paymentMovement,
  externalRef: cause,
  occurredAt: at,
  cause,
  origin,
})

const burns = (deps: BillingDeps, minted: Minted, plan: { lotId: string; amount: number }[], movement: string, at: number): CauseEvent[] =>
  plan.map(p => {
    const lot = minted.lots.find(l => l.id === p.lotId)!
    return {
      id: `${movement}:reclaim:${p.lotId}`,
      accountId: minted.accountId,
      kind: "burn",
      asset: deps.manifest.primaryAsset,
      partitionId: lot.partitionId,
      restriction: lot.restriction,
      amount: p.amount,
      lotId: p.lotId,
      occurredAt: at,
      cause: movement,
      origin: "reclaim",
    }
  })

/** Give back what `movement` reclaimed, in new lots with the partition, restriction and expiry of the lots it took from. */
function giveBack(events: CauseEvent[], movement: string, paymentMovement: string, origin: string, suffix: string, at: number): CauseEvent[] {
  const lots = new Map(fold(events, at).map(l => [l.id, l]))
  return events
    .filter(e => e.id.startsWith(`${movement}:reclaim:`))
    .map(e => {
      const id = `${movement}:${suffix}:${e.lotId}`
      const expiresAt = lots.get(e.lotId)?.expiresAt
      const back: CauseEvent = {
        id,
        accountId: e.accountId,
        kind: "mint",
        asset: e.asset,
        partitionId: e.partitionId,
        restriction: e.restriction,
        amount: e.amount,
        lotId: id,
        correlationId: paymentMovement,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        occurredAt: at,
        cause: movement,
        origin,
      }
      return back
    })
}

/** Account that holds a payment: found through the fact's movement in the journals the caller names. */
export interface ReclaimTarget {
  accountId: string
}

/**
 * A verified refund. Takes back credits per rule 6 for the share this refund
 * adds to what was already taken back of the payment, and closes the
 * subscription period of the payment once that share is the whole payment
 * (rule 7). The rail refund of the money is not done here.
 */
export async function applyRefund(deps: BillingDeps, fact: RefundFact, target: ReclaimTarget): Promise<{ status: "applied" | "replayed" | "unknown_payment"; reclaimed: number }> {
  return serial(`reclaim:${fact.paymentMovement}`, async () => {
    const now = fact.at
    const events = (await deps.storage.loadEvents(target.accountId)) as CauseEvent[]
    const fiat = events.find(e => e.id === `${fact.paymentMovement}:fiat`)
    const minted = mintedFrom(events, deps.manifest.primaryAsset, target.accountId, fact.paymentMovement, now)
    if (!minted || !fiat) return { status: "unknown_payment", reclaimed: 0 } as const
    if (events.some(e => e.id.startsWith(`${fact.movement}:`))) return { status: "replayed", reclaimed: 0 } as const
    const amount = Number.isFinite(fact.amountMinor) ? Math.max(0, Math.floor(fact.amountMinor)) : 0
    const before = takenBackMinor(events, fact.paymentMovement)
    const after = Math.min(minted.paid, before + amount)
    const plan = planShare(minted, before, after, now)
    const out = burns(deps, minted, plan, fact.movement, now)
    // Recorded even when it reclaims nothing (all spent), so the share stays exact.
    out.push(marker(fiat, `${fact.movement}:refund:${amount}`, fact.movement, fact.paymentMovement, ORIGIN_REFUND, now))
    await deps.storage.commit(target.accountId, out)
    if (after >= minted.paid) await closePeriod(deps, fact.paymentMovement, "refunded", now)
    return { status: "applied", reclaimed: plan.reduce((s, p) => s + p.amount, 0) } as const
  })
}

/**
 * A refund that had succeeded and then failed or was canceled: the money is
 * back with the merchant. Gives back what that refund took (same partitions,
 * restrictions and expiries) and reopens the period it closed. Once per refund;
 * a refund fails as a whole, so `amountMinor` is informative.
 */
export async function applyRefundReversal(
  deps: BillingDeps,
  fact: RefundReversedFact,
  target: ReclaimTarget,
): Promise<{ status: "applied" | "replayed" | "unknown_payment" | "unknown_refund"; restored: number }> {
  return serial(`reclaim:${fact.paymentMovement}`, async () => {
    const now = fact.at
    const events = (await deps.storage.loadEvents(target.accountId)) as CauseEvent[]
    const fiat = events.find(e => e.id === `${fact.paymentMovement}:fiat`)
    if (!fiat) return { status: "unknown_payment", restored: 0 } as const
    const refunded = events.some(e => e.origin === ORIGIN_REFUND && e.correlationId === fact.paymentMovement && e.id.startsWith(`${fact.movement}:refund:`))
    if (!refunded) return { status: "unknown_refund", restored: 0 } as const
    if (events.some(e => e.id === `${fact.movement}:reversed`)) return { status: "replayed", restored: 0 } as const
    const out = giveBack(events, fact.movement, fact.paymentMovement, ORIGIN_REFUND_REVERSED, "reversed", now)
    const restored = out.reduce((s, e) => s + e.amount, 0)
    out.push(marker(fiat, `${fact.movement}:reversed`, fact.movement, fact.paymentMovement, ORIGIN_REFUND_REVERSED, now))
    await deps.storage.commit(target.accountId, out)
    if (takenBackMinor([...events, ...out], fact.paymentMovement) < fiat.amount) await reopenPeriod(deps, fact.paymentMovement)
    return { status: "applied", restored } as const
  })
}

/**
 * A dispute (rule 8), for its amount only:
 *   `opened` freezes the credits the disputed amount stands for: a hold on the
 *            payment's lots first, then on the other live lots of the account;
 *   `lost`   releases the freeze and takes back that share, cumulative with the
 *            refunds and other disputes of the payment and capped at it; the
 *            period closes once the share is the whole payment;
 *   `won`    releases the freeze or, after a loss, gives back what was taken
 *            and reopens the period.
 * Several disputes of one payment are handled each by its own movement. An
 * inquiry that moves no money never reaches here: a rail emits no fact for it.
 */
export async function applyDispute(
  deps: BillingDeps,
  fact: DisputeFact,
  target: ReclaimTarget,
): Promise<{ status: "applied" | "replayed" | "unknown_payment"; held?: number; reclaimed?: number; restored?: number }> {
  return serial(`reclaim:${fact.paymentMovement}`, async () => {
    const acct = target.accountId
    const now = fact.at
    const dp = fact.movement
    const events = (await deps.storage.loadEvents(acct)) as CauseEvent[]
    const fiat = events.find(e => e.id === `${fact.paymentMovement}:fiat`)
    if (!fiat) return { status: "unknown_payment" } as const
    const paid = fiat.amount
    // A disputed amount in another currency than the payment's is taken as the whole payment.
    const sameCurrency = typeof fact.currency === "string" && normalizeCurrency(fact.currency) === normalizeRef(fiat.asset)
    const disputed = sameCurrency && Number.isFinite(fact.amountMinor) ? Math.min(paid, Math.max(0, Math.floor(fact.amountMinor))) : paid
    const ids = new Set(events.map(e => e.id))
    const lostDone = events.some(e => e.id.startsWith(`${dp}:lost:`))
    const openHolds = events.filter(
      e => e.kind === "reserve" && e.correlationId === dp && !ids.has(`${dp}:release:${e.lotId}`) && !ids.has(`${dp}:capture:${e.lotId}`),
    )
    const release = (origin: string): CauseEvent[] => openHolds.map(h => ({ ...h, id: `${dp}:release:${h.lotId}`, kind: "release", occurredAt: now, origin }))

    if (fact.status === "opened") {
      // Late `opened` after a loss or a win: nothing to freeze.
      if (events.some(e => e.id.startsWith(`${dp}:`))) return { status: "replayed" } as const
      const minted = mintedFrom(events, deps.manifest.primaryAsset, acct, fact.paymentMovement, now)
      const total = minted?.total ?? 0
      let budget = paid > 0 ? Math.ceil((disputed * total) / paid - EPS) : 0
      const own = new Set(minted?.lots.map(l => l.id) ?? [])
      const lots = fold(events, now)
        .filter(l => l.asset === deps.manifest.primaryAsset && live(l, now) > 0)
        .sort((a, b) => Number(own.has(b.id)) - Number(own.has(a.id)) || b.createdAt - a.createdAt)
      const out: CauseEvent[] = []
      for (const l of lots) {
        if (budget <= 0) break
        const amount = Math.min(budget, live(l, now))
        out.push({
          id: `${dp}:hold:${l.id}`,
          accountId: acct,
          kind: "reserve",
          asset: l.asset,
          partitionId: l.partitionId,
          restriction: l.restriction,
          amount,
          lotId: l.id,
          correlationId: dp,
          occurredAt: now,
          cause: dp,
        })
        budget -= amount
      }
      if (out.length > 0) await deps.storage.commit(acct, out)
      return { status: "applied", held: out.reduce((s, h) => s + h.amount, 0) } as const
    }

    if (fact.status === "lost") {
      if (lostDone) return { status: "replayed" } as const
      const released = release("dispute-lost")
      const minted = mintedFrom([...events, ...released], deps.manifest.primaryAsset, acct, fact.paymentMovement, now)!
      const before = takenBackMinor(events, fact.paymentMovement)
      const upTo = Math.min(paid, before + disputed)
      const plan = planShare(minted, before, upTo, now)
      const out = [...released, ...burns(deps, minted, plan, dp, now), marker(fiat, `${dp}:lost:${disputed}`, dp, fact.paymentMovement, ORIGIN_DISPUTE_LOST, now)]
      await deps.storage.commit(acct, out)
      if (upTo >= paid) await closePeriod(deps, fact.paymentMovement, "disputed", now)
      return { status: "applied", reclaimed: plan.reduce((s, p) => s + p.amount, 0) } as const
    }

    // won
    if (lostDone) {
      if (ids.has(`${dp}:reinstated`)) return { status: "replayed" } as const
      const out = giveBack(events, dp, fact.paymentMovement, ORIGIN_DISPUTE_REINSTATED, "reinstated", now)
      const restored = out.reduce((s, e) => s + e.amount, 0)
      out.push(marker(fiat, `${dp}:reinstated`, dp, fact.paymentMovement, ORIGIN_DISPUTE_REINSTATED, now))
      await deps.storage.commit(acct, out)
      if (takenBackMinor([...events, ...out], fact.paymentMovement) < paid) await reopenPeriod(deps, fact.paymentMovement)
      return { status: "applied", restored } as const
    }
    if (openHolds.length === 0) return { status: "replayed" } as const
    await deps.storage.commit(acct, release("dispute-won"))
    return { status: "applied", reclaimed: 0 } as const
  })
}
