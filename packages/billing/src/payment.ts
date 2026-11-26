/**
 * The payment path of AIP-74: check, fact, effect, trace.
 *
 *   rail event -> verifyWebhook -> PaymentFact
 *   1. CHECK   offer, rail, currency, amount against the price (net of an
 *              exclusive tax, plus an allowed discount; zero only for a trial);
 *              a fact the rail marks `unsupported` is refused with its reason
 *   2. FACT    mint the fiat amount, cause = movement
 *   3. EFFECT  by price.model: prepaid-pool converts (plus bonus lot),
 *              one-time burns the fiat and gives `includes` once,
 *              subscription burns the fiat, opens a period and gives its includes
 *   4. TRACE   every entry carries `cause = movement`
 *
 * Steps 1 to 3 are ONE `StoragePort.commit` (rule 3). A failed check writes the
 * fiat mint alone: the money was received, so its lot stays open and is listed
 * as owed (rule 4), never dropped.
 *
 * A replay is decided on the EFFECT, not on the fiat mint: a payment listed as
 * owed because its first fact was incomplete (no offer, say) is completed once
 * by a valid fact of the same movement, same amount and same currency. A fact
 * of the same movement with another amount or currency writes nothing and is
 * returned as a `conflict`, for an alert.
 */
import { fold, meet, type Lot, type Restriction } from "@agentproto/wallet"
import type { StoragePort } from "@agentproto/wallet/ports"
import type { BillingHandle } from "./define-billing-manifest.js"
import type { Offer } from "./types.js"
import { addDuration, convertMinor, fiatPartition, isFiatRef, normalizeCurrency, normalizeRef } from "./model.js"
import type { BillingDeps, CauseEvent, PeriodRecord } from "./ports.js"
import { dropEvents, graceMsOf, periodBounds, dueDrops } from "./periods.js"
import type { PaymentFact } from "./settlement.js"

export type PaymentOutcome =
  | { status: "applied"; movement: string; events: CauseEvent[] }
  | { status: "replayed"; movement: string }
  | { status: "refused"; movement: string; reason: string; owedMinor: number; currency: string }
  | {
      status: "conflict"
      movement: string
      /** What the journal holds for this movement. */
      recorded: { amountMinor: number; currency: string }
      /** What the new fact says. Nothing of it was written. */
      received: { amountMinor: number; currency: string }
    }

/** `trial`: a zero payment that opens the offer's trial period. */
export type CheckResult = { ok: true; offer: Offer; trial?: true } | { ok: false; reason: string }

/** The account a payment lands on: the values of `payer.owner`, in order (rule 20). */
export function accountIdFor(manifest: BillingHandle, owner: Record<string, string>): string {
  const parts = manifest.payer.owner.map(k => {
    const v = owner[k]
    if (typeof v !== "string" || v === "") throw new Error(`owner key '${k}' is missing`)
    return v
  })
  return parts.join(":")
}

/** Step 1. Pure. */
export function checkPayment(manifest: BillingHandle, fact: PaymentFact): CheckResult {
  // The rail could not tie this money to one offer and one payer: owed, never credited.
  if (typeof fact.unsupported === "string") return { ok: false, reason: `the rail cannot apply this payment: ${fact.unsupported || "unsupported"}` }
  const offer = manifest.derived.offers.get(fact.offerId)
  if (!offer) return { ok: false, reason: `unknown offer '${fact.offerId}'` }
  if (!manifest.rails.some(r => r.id === fact.rail)) return { ok: false, reason: `rail '${fact.rail}' is not declared` }
  const price = offer.price
  if (price.model.startsWith("x-")) return { ok: false, reason: `offer model '${price.model}' is not handled by the core path` }
  if (typeof price.currency !== "string") return { ok: false, reason: "offer has no currency" }
  if (normalizeCurrency(fact.currency) !== normalizeCurrency(price.currency)) {
    return { ok: false, reason: `currency ${fact.currency} differs from the price currency ${price.currency}` }
  }
  if (!Number.isInteger(fact.amountMinor) || fact.amountMinor < 0) return { ok: false, reason: "amount is not a non-negative integer" }
  if (!Number.isInteger(fact.taxMinor) || fact.taxMinor < 0 || fact.taxMinor > fact.amountMinor) return { ok: false, reason: "tax is out of range" }
  const discount = fact.discountMinor ?? 0
  if (!Number.isInteger(discount) || discount < 0) return { ok: false, reason: "discount is not a non-negative integer" }
  if (discount > 0 && offer.discounts !== "allow") return { ok: false, reason: `offer '${offer.id}' does not accept a discount` }
  if (fact.amountMinor === 0 && discount === 0) {
    // A zero payment with no discount is a trial, or nothing.
    if (price.model === "subscription" && offer.subscription?.trial !== undefined) return { ok: true, offer, trial: true }
    return { ok: false, reason: "a zero payment is only accepted on an offer with a trial" }
  }
  // The price this payment stands for: the paid amount net of a tax added on top, plus the discount.
  const listed = fact.amountMinor - (fact.taxBehavior === "exclusive" ? fact.taxMinor : 0) + discount
  if (price.amountMinor === "buyer") {
    const { minMinor, maxMinor } = price as { minMinor?: number; maxMinor?: number }
    if (minMinor !== undefined && listed < minMinor) return { ok: false, reason: `amount ${listed} is under the minimum ${minMinor}` }
    if (maxMinor !== undefined && listed > maxMinor) return { ok: false, reason: `amount ${listed} is over the maximum ${maxMinor}` }
  } else if (listed !== price.amountMinor) {
    return { ok: false, reason: `amount ${listed} differs from the price ${price.amountMinor}` }
  }
  if (price.model === "prepaid-pool") {
    const c = offer.convert ? manifest.derived.conversions.get(offer.convert) : undefined
    if (!c) return { ok: false, reason: `unknown conversion '${offer.convert}'` }
    if (!c.enabled) return { ok: false, reason: `conversion '${c.id}' is disabled` }
    if (c.rail !== fact.rail) return { ok: false, reason: `conversion '${c.id}' runs on rail '${c.rail}', not '${fact.rail}'` }
  }
  return { ok: true, offer }
}

/** Percent of the highest tier whose `from` is at most the paid amount (AIP-74 bonus). */
export function bonusPercent(tiers: readonly (readonly [number, number])[], amountMinor: number): number {
  let best: readonly [number, number] | undefined
  for (const t of tiers) if (t[0] <= amountMinor && (best === undefined || t[0] > best[0])) best = t
  return best ? best[1] : 0
}

const expiryOf = (
  spec: { after: string } | { atPeriodEnd: true } | undefined,
  partitionTtl: number | undefined,
  at: number,
  periodEnd?: number,
): number | undefined => {
  if (spec && "after" in spec) return addDuration(at, spec.after)
  if (spec && "atPeriodEnd" in spec) return periodEnd
  return partitionTtl !== undefined ? at + partitionTtl : undefined
}

/** Steps 2 and 3 of one fact. Pure: the events of the commit and the period to open, if any. */
export function planPayment(
  manifest: BillingHandle,
  fact: PaymentFact,
  accountId: string,
  continuesAt?: number,
): { check: CheckResult; events: CauseEvent[]; period?: PeriodRecord; access?: { features: string[] } } {
  const m = fact.movement
  const cur = normalizeCurrency(fact.currency)
  const fiatLot = `${m}:fiat`
  const events: CauseEvent[] = [
    {
      id: fiatLot,
      accountId,
      kind: "mint",
      asset: cur,
      partitionId: fiatPartition(cur),
      restriction: [],
      amount: fact.amountMinor,
      lotId: fiatLot,
      externalRef: m,
      occurredAt: fact.paidAt,
      cause: m,
      origin: "payment",
    },
  ]
  const check = checkPayment(manifest, fact)
  if (!check.ok) return { check, events }
  const offer = check.offer
  const burn = (id: string, amount: number): CauseEvent => ({
    id: `${m}:${id}`,
    accountId,
    kind: "burn",
    asset: cur,
    partitionId: fiatPartition(cur),
    restriction: [],
    amount,
    lotId: fiatLot,
    occurredAt: fact.paidAt,
    cause: m,
  })

  if (offer.price.model === "prepaid-pool") {
    const c = manifest.derived.conversions.get(offer.convert!)!
    const input = manifest.taxBasis === "net" ? fact.amountMinor - fact.taxMinor : fact.amountMinor
    const out = convertMinor(input, c.ratio, c.fromDecimals, c.toDecimals)
    const part = manifest.derived.partitions.get(c.mintPartition)
    const restriction: Restriction = meet(part?.restriction ?? [], c.edge.addsRestriction ?? [])
    const expiresAt = expiryOf(c.expires, part?.defaultTtlMs, fact.paidAt)
    events.push({
      id: `${m}:cout`,
      accountId,
      kind: "convert_out",
      asset: cur,
      partitionId: fiatPartition(cur),
      restriction: [],
      amount: input,
      lotId: fiatLot,
      correlationId: `${m}:conv`,
      occurredAt: fact.paidAt,
      cause: m,
    })
    events.push({
      id: `${m}:cin`,
      accountId,
      kind: "convert_in",
      asset: manifest.primaryAsset,
      partitionId: c.mintPartition,
      restriction,
      amount: out,
      lotId: `${m}:cin`,
      correlationId: `${m}:conv`,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      occurredAt: fact.paidAt,
      cause: m,
      origin: "purchase",
    })
    // The part of the paid amount that is tax is not ours: it closes the fiat lot.
    if (fact.amountMinor - input > 0) events.push(burn("tax", fact.amountMinor - input))
    if (c.bonus) {
      const pct = bonusPercent(c.bonus.tiers, input)
      const bonus = Math.floor((out * pct) / 100)
      if (bonus > 0) {
        const bp = manifest.derived.partitions.get(c.bonus.partition)
        events.push({
          id: `${m}:bonus`,
          accountId,
          kind: "mint",
          asset: manifest.primaryAsset,
          partitionId: c.bonus.partition,
          restriction: bp?.restriction ?? [],
          amount: bonus,
          lotId: `${m}:bonus`,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          occurredAt: fact.paidAt,
          cause: m,
          origin: "bonus",
        })
      }
    }
    return { check, events }
  }

  events.push(burn("fiat-burn", fact.amountMinor))
  if (offer.price.model === "one-time") {
    for (const inc of offer.includes ?? []) {
      if (!("amountMinor" in inc) || inc.amountMinor <= 0) continue
      const part = manifest.derived.partitions.get(inc.partition)
      // The schema default is "none" (BILLING.schema.json): the include then expires with the
      // partition's TTL if it has one. `unbounded` keeps it: never expires (rule 16).
      const expiresAt = (inc.rollover ?? "none") === "unbounded" ? undefined : expiryOf(undefined, part?.defaultTtlMs, fact.paidAt)
      events.push({
        id: `${m}:incl:0:${inc.feature}`,
        accountId,
        kind: "mint",
        asset: manifest.primaryAsset,
        partitionId: inc.partition,
        restriction: part?.restriction ?? [],
        amount: inc.amountMinor,
        lotId: `${m}:incl:0:${inc.feature}`,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        occurredAt: fact.paidAt,
        cause: m,
        origin: "include",
      })
    }
    const features = (offer.includes ?? []).filter(i => !("amountMinor" in i)).map(i => i.feature)
    return { check, events, access: { features } }
  }

  // subscription. A trial period runs for the offer's `trial` from the payment, then the first paid period continues it.
  const { startAt, endAt } = check.trial
    ? { startAt: continuesAt ?? fact.paidAt, endAt: addDuration(continuesAt ?? fact.paidAt, offer.subscription!.trial!) }
    : periodBounds(offer, fact.paidAt, continuesAt)
  const price = offer.price as Extract<Offer["price"], { model: "subscription" }>
  const period: PeriodRecord = {
    id: m,
    accountId,
    offerId: offer.id,
    startAt,
    endAt,
    interval: price.interval,
    graceMs: graceMsOf(offer, endAt),
    status: "active",
    given: [],
    features: (offer.includes ?? []).filter(i => !("amountMinor" in i)).map(i => i.feature),
    ...(check.trial ? { trial: true } : {}),
  }
  const due = dueDrops(period, fact.paidAt)
  for (const d of due) events.push(...dropEvents(manifest, offer, period, d))
  period.given = due.map(d => d.index)
  return { check, events, period }
}

/** In-process serialisation by key. The host's storage must also serialise per account (AIP-49 StoragePort). */
const chains = new Map<string, Promise<unknown>>()
export function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chains.set(key, next)
  next
    .finally(() => {
      if (chains.get(key) === next) chains.delete(key)
    })
    .catch(() => undefined)
  return next as Promise<T>
}

/**
 * Apply a verified payment, once (rules 1 to 5). A replay writes nothing; a
 * refused payment is completed by the first valid fact of the same movement.
 */
export async function applyPayment(deps: BillingDeps, fact: PaymentFact): Promise<PaymentOutcome> {
  const { manifest } = deps
  let accountId: string
  try {
    accountId = accountIdFor(manifest, fact.owner)
  } catch (e) {
    return { status: "refused", movement: fact.movement, reason: (e as Error).message, owedMinor: fact.amountMinor, currency: fact.currency }
  }
  return serial(`payment:${fact.movement}`, async () => {
    const m = fact.movement
    const journal = (await deps.storage.loadEvents(accountId)) as CauseEvent[]
    const fiat = journal.find(e => e.id === `${m}:fiat`)
    if (fiat) {
      const recorded = { amountMinor: fiat.amount, currency: normalizeRef(fiat.asset) }
      const received = { amountMinor: fact.amountMinor, currency: normalizeCurrency(fact.currency) }
      if (recorded.amountMinor !== received.amountMinor || recorded.currency !== received.currency) {
        return { status: "conflict", movement: m, recorded, received } as PaymentOutcome
      }
    }
    // The effect is every entry of the movement past its fiat mint (conversion, burn, includes).
    const effectDone = journal.some(e => e.cause === m && e.id !== `${m}:fiat`)
    // A renewal continues the open period of the same offer, so the periods chain without a gap.
    const prior = (await deps.state.listPeriods({ accountId, offerId: fact.offerId }))
      .filter(p => p.status !== "closed" && p.id !== fact.movement)
      .sort((a, b) => b.endAt - a.endAt)[0]
    const plan = planPayment(manifest, fact, accountId, prior && prior.endAt + prior.graceMs > fact.paidAt ? prior.endAt : undefined)
    // Nothing more to write once the effect is there, or while the facts stay incomplete.
    const replay = effectDone || (fiat !== undefined && !plan.check.ok)
    const toWrite = fiat ? plan.events.filter(e => e.id !== fiat.id) : plan.events
    if (!replay) await deps.storage.commit(accountId, toWrite)
    // State follows the commit and is idempotent by id, so a crash between the two is repaired by a replay.
    await deps.state.putPayment(fact.movement, accountId)
    if (plan.check.ok) {
      if (plan.period && !(await deps.state.getPeriod(plan.period.id))) {
        await deps.state.putPeriod(plan.period)
        if (prior) await deps.state.putPeriod({ ...prior, status: "closed", closedAt: fact.paidAt, closedReason: "renewed" })
      }
      if (plan.access && !(await deps.state.getAccess(fact.movement))) {
        await deps.state.putAccess({ id: fact.movement, accountId, features: plan.access.features })
      }
    }
    if (replay) return { status: "replayed", movement: fact.movement } as PaymentOutcome
    if (!plan.check.ok) {
      return { status: "refused", movement: fact.movement, reason: plan.check.reason, owedMinor: fact.amountMinor, currency: normalizeCurrency(fact.currency) } as PaymentOutcome
    }
    return { status: "applied", movement: fact.movement, events: toWrite } as PaymentOutcome
  })
}

/** Rule 5: everything the journal holds for one movement, from the journal alone. */
export async function traceOf(storage: StoragePort, accountId: string, movement: string): Promise<CauseEvent[]> {
  return ((await storage.loadEvents(accountId)) as CauseEvent[]).filter(e => e.cause === movement)
}

export interface OwedEntry {
  movement: string
  asset: string
  remaining: number
  lotId: string
}

/** Rule 4: fiat lots still open are money received and not applied. */
export async function listOwed(storage: StoragePort, accountId: string, now = Date.now()): Promise<OwedEntry[]> {
  const events = (await storage.loadEvents(accountId)) as CauseEvent[]
  const byLot = new Map(events.map(e => [e.id, e]))
  const lots: Lot[] = fold(events, now)
  return lots
    .filter(l => isFiatRef(l.asset) && l.remaining > 0)
    .map(l => ({ movement: byLot.get(l.sourceEventId)?.cause ?? l.sourceEventId, asset: l.asset, remaining: l.remaining, lotId: l.id }))
}
