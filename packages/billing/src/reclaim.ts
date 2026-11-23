/**
 * Refunds and disputes (AIP-74 rules 6 to 8).
 *
 * The money refund is the merchant's decision and the rail's act. The journal
 * only takes back credits, and never more than: the share of the payment that
 * was refunded times what the payment minted, what is still unreserved and
 * unexpired in the lots it minted, and never the bonus (rule 12).
 */
import { fold, type Lot } from "@agentproto/wallet"
import { serial } from "./payment.js"
import { closePeriod } from "./periods.js"
import type { BillingDeps, CauseEvent } from "./ports.js"
import type { DisputeFact, RefundFact } from "./settlement.js"

export interface Minted {
  accountId: string
  paid: number
  lots: Lot[]
}

/** The non-bonus credit lots a payment minted, and what it paid. Null when the payment is unknown. */
async function mintedBy(deps: BillingDeps, accountId: string, paymentMovement: string, now: number): Promise<Minted | null> {
  const events = (await deps.storage.loadEvents(accountId)) as CauseEvent[]
  const fiat = events.find(e => e.id === `${paymentMovement}:fiat`)
  if (!fiat) return null
  const byId = new Map(events.map(e => [e.id, e]))
  const lots = fold(events, now).filter(l => {
    const src = byId.get(l.sourceEventId)
    return src?.cause === paymentMovement && src.origin !== "bonus" && l.asset === deps.manifest.primaryAsset
  })
  return { accountId, paid: fiat.amount, lots }
}

const live = (l: Lot, now: number): number =>
  l.expiresAt !== undefined && l.expiresAt <= now ? 0 : Math.max(0, l.remaining - l.reserved)

/** Rule 6. Pure. The lots to burn and by how much, newest lot first. */
export function planReclaim(minted: Minted, refundedMinor: number, now: number): { lotId: string; amount: number }[] {
  const total = minted.lots.reduce((s, l) => s + l.original, 0)
  const share = Math.min(1, refundedMinor / minted.paid)
  let budget = Math.min(Math.floor(share * total + 1e-9), minted.lots.reduce((s, l) => s + live(l, now), 0))
  const out: { lotId: string; amount: number }[] = []
  for (const l of [...minted.lots].sort((a, b) => b.createdAt - a.createdAt)) {
    const take = Math.min(budget, live(l, now))
    if (take > 0) out.push({ lotId: l.id, amount: take })
    budget -= take
    if (budget <= 0) break
  }
  return out
}

/** Account that holds a payment: found through the fact's movement in the journals the caller names. */
export interface ReclaimTarget {
  accountId: string
}

/**
 * A verified refund. Takes back credits per rule 6 and closes the subscription
 * period of the payment (rule 7). The rail refund of the money is not done here.
 */
export async function applyRefund(deps: BillingDeps, fact: RefundFact, target: ReclaimTarget): Promise<{ status: "applied" | "replayed" | "unknown_payment"; reclaimed: number }> {
  return serial(`refund:${fact.movement}`, async () => {
    const now = fact.at
    const minted = await mintedBy(deps, target.accountId, fact.paymentMovement, now)
    if (!minted) return { status: "unknown_payment", reclaimed: 0 } as const
    const journal = await deps.storage.loadEvents(target.accountId)
    if (journal.some(e => e.id.startsWith(`${fact.movement}:`))) return { status: "replayed", reclaimed: 0 } as const
    const plan = planReclaim(minted, fact.amountMinor, now)
    const events: CauseEvent[] = plan.map(p => ({
      id: `${fact.movement}:reclaim:${p.lotId}`,
      accountId: target.accountId,
      kind: "burn",
      asset: deps.manifest.primaryAsset,
      partitionId: minted.lots.find(l => l.id === p.lotId)!.partitionId,
      restriction: minted.lots.find(l => l.id === p.lotId)!.restriction,
      amount: p.amount,
      lotId: p.lotId,
      occurredAt: now,
      cause: fact.movement,
      origin: "reclaim",
    }))
    // Marker so a refund that reclaims nothing (all spent) is still recorded once.
    events.push({
      id: `${fact.movement}:refund`,
      accountId: target.accountId,
      kind: "burn",
      asset: deps.manifest.primaryAsset,
      partitionId: minted.lots[0]?.partitionId ?? `${deps.manifest.primaryAsset}:default`,
      restriction: [],
      amount: 0,
      lotId: minted.lots[0]?.id ?? `${fact.paymentMovement}:fiat`,
      occurredAt: now,
      cause: fact.movement,
      origin: "refund",
    })
    await deps.storage.commit(target.accountId, events)
    await closePeriod(deps, fact.paymentMovement, "refunded", now)
    return { status: "applied", reclaimed: plan.reduce((s, p) => s + p.amount, 0) } as const
  })
}

/**
 * A dispute. `opened` freezes spending on the payer account (a hold on every
 * unreserved lot of the primary asset); `won` releases it; `lost` applies rule 6
 * with a refunded share of 1, releases the rest and closes the period (rule 8).
 */
export async function applyDispute(deps: BillingDeps, fact: DisputeFact, target: ReclaimTarget): Promise<{ status: string; held?: number; reclaimed?: number }> {
  return serial(`dispute:${fact.movement}:${fact.status}`, async () => {
    const acct = target.accountId
    const events = (await deps.storage.loadEvents(acct)) as CauseEvent[]
    const done = (suffix: string) => events.some(e => e.id.startsWith(`${fact.movement}:${suffix}`))
    const now = fact.at
    if (fact.status === "opened") {
      if (done("hold:")) return { status: "replayed" }
      const lots = fold(events, now).filter(l => l.asset === deps.manifest.primaryAsset && live(l, now) > 0)
      const holds: CauseEvent[] = lots.map(l => ({
        id: `${fact.movement}:hold:${l.id}`,
        accountId: acct,
        kind: "reserve",
        asset: l.asset,
        partitionId: l.partitionId,
        restriction: l.restriction,
        amount: live(l, now),
        lotId: l.id,
        correlationId: fact.movement,
        occurredAt: now,
        cause: fact.movement,
      }))
      if (holds.length > 0) await deps.storage.commit(acct, holds)
      return { status: "applied", held: holds.reduce((s, h) => s + h.amount, 0) }
    }
    const holds = events.filter(e => e.kind === "reserve" && e.correlationId === fact.movement)
    const settled = (lotId: string) => events.some(e => (e.id === `${fact.movement}:release:${lotId}` || e.id === `${fact.movement}:capture:${lotId}`))
    const open = holds.filter(h => !settled(h.lotId))
    if (open.length === 0) return { status: "replayed" }
    const out: CauseEvent[] = []
    let reclaimed = 0
    if (fact.status === "won") {
      for (const h of open) out.push({ ...h, id: `${fact.movement}:release:${h.lotId}`, kind: "release", occurredAt: now, origin: "dispute-won" })
    } else {
      const minted = await mintedBy(deps, acct, fact.paymentMovement, now)
      let budget = minted ? minted.lots.reduce((s, l) => s + l.original, 0) : 0
      const fromPayment = new Set(minted?.lots.map(l => l.id) ?? [])
      for (const h of open) {
        const take = fromPayment.has(h.lotId) ? Math.min(budget, h.amount) : 0
        if (take > 0) {
          out.push({ ...h, id: `${fact.movement}:capture:${h.lotId}`, kind: "capture", amount: take, occurredAt: now, origin: "reclaim" })
          budget -= take
          reclaimed += take
        }
        if (h.amount - take > 0) out.push({ ...h, id: `${fact.movement}:release:${h.lotId}`, kind: "release", amount: h.amount - take, occurredAt: now, origin: "dispute-lost" })
      }
      await closePeriod(deps, fact.paymentMovement, "disputed", now)
    }
    if (out.length > 0) await deps.storage.commit(acct, out)
    return { status: "applied", reclaimed }
  })
}
