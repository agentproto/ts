/**
 * Paid subscription periods and the includes they give (AIP-74 rules 7, 16, 17).
 *
 * A period is opened by a subscription payment and keyed by its movement. The
 * includes of a monthly or weekly period are given once, at its start; a yearly
 * period gives them monthly (twelve drops), which is what makes "a refund
 * closes the period" (rule 7) matter: month 3 to 12 are never given.
 */
import { meet, type Restriction } from "@agentproto/wallet"
import type { BillingHandle } from "./define-billing-manifest.js"
import type { Offer } from "./types.js"
import { addDuration, addMonthsUtc } from "./model.js"
import type { BillingDeps, CauseEvent, PeriodRecord } from "./ports.js"

export interface IncludeDrop {
  index: number
  /** Epoch ms the drop is due. */
  at: number
  /** End of the window the drop belongs to. */
  windowEnd: number
}

export const graceMsOf = (offer: Offer, from: number): number =>
  offer.subscription?.grace ? addDuration(from, offer.subscription.grace) - from : 0

/** Bounds of a period opened by a payment at `paidAt`, `anchor` and `interval` of the offer. */
export function periodBounds(
  offer: Offer,
  paidAt: number,
  continuesAt?: number,
): { startAt: number; endAt: number } {
  if (offer.price.model !== "subscription" || !offer.subscription) throw new Error(`offer '${offer.id}' is not a subscription`)
  const { interval, intervalCount = 1 } = offer.price as { interval: "week" | "month" | "year"; intervalCount?: number }
  let start = continuesAt ?? paidAt
  if (offer.subscription.anchor === "calendar" && continuesAt === undefined) {
    // First day of the calendar month (or year) containing the payment, UTC.
    const d = new Date(paidAt)
    start = interval === "year" ? Date.UTC(d.getUTCFullYear(), 0, 1) : interval === "month" ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) : paidAt
  }
  const end =
    interval === "year"
      ? addMonthsUtc(start, 12 * intervalCount)
      : interval === "month"
        ? addMonthsUtc(start, intervalCount)
        : start + 7 * 86_400_000 * intervalCount
  return { startAt: start, endAt: end }
}

/** Drops of a period, all of them (given or not). */
export function includeDrops(p: Pick<PeriodRecord, "startAt" | "endAt" | "interval"> & { trial?: boolean }): IncludeDrop[] {
  if (p.interval !== "year" || p.trial) return [{ index: 0, at: p.startAt, windowEnd: p.endAt }]
  const years = Math.max(1, Math.round((p.endAt - p.startAt) / (365 * 86_400_000)))
  return Array.from({ length: 12 * years }, (_, k) => ({
    index: k,
    at: addMonthsUtc(p.startAt, k),
    windowEnd: addMonthsUtc(p.startAt, k + 1),
  }))
}

/** Drops due at `now` that were not given, none once the period is closed (rule 7). */
export function dueDrops(p: PeriodRecord, now: number): IncludeDrop[] {
  if (p.status === "closed") return []
  return includeDrops(p).filter(d => d.at <= now && !p.given.includes(d.index))
}

/** Events of one drop: credits into their partitions, expiry from one source (AIP-74 Expiry). */
export function dropEvents(
  manifest: BillingHandle,
  offer: Offer,
  period: Pick<PeriodRecord, "id" | "accountId" | "endAt" | "graceMs">,
  drop: IncludeDrop,
): CauseEvent[] {
  const out: CauseEvent[] = []
  for (const inc of offer.includes ?? []) {
    if (!("amountMinor" in inc) || inc.amountMinor <= 0) continue
    const part = manifest.derived.partitions.get(inc.partition)
    const rollover = inc.rollover ?? "none"
    // `none`: the unspent remainder expires at the end of the window. The last drop of a
    // period also covers its grace (includes continue during it, rule 17).
    const isLast = drop.windowEnd >= period.endAt
    const expiresAt =
      rollover === "none"
        ? drop.windowEnd + (isLast ? period.graceMs : 0)
        : part?.defaultTtlMs !== undefined
          ? drop.at + part.defaultTtlMs
          : undefined
    const id = `${period.id}:incl:${drop.index}:${inc.feature}`
    out.push({
      id,
      accountId: period.accountId,
      kind: "mint",
      asset: manifest.derived.partitions.get(inc.partition)?.asset ?? manifest.primaryAsset,
      partitionId: inc.partition,
      restriction: meet(part?.restriction ?? [], [] as Restriction),
      amount: inc.amountMinor,
      lotId: id,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      occurredAt: drop.at,
      cause: period.id,
      origin: "include",
    })
  }
  return out
}

/** Give every due drop of every open period, idempotently (keys are in the event ids). */
export async function runDueIncludes(deps: BillingDeps, now = deps.clock.nowMs()): Promise<{ given: number }> {
  let given = 0
  for (const p of await deps.state.listPeriods()) {
    const drops = dueDrops(p, now)
    if (drops.length === 0) continue
    const offer = deps.manifest.derived.offers.get(p.offerId)
    if (!offer) continue
    const events = drops.flatMap(d => dropEvents(deps.manifest, offer, p, d))
    const known = new Set((await deps.storage.loadEvents(p.accountId)).map(e => e.id))
    const fresh = events.filter(e => !known.has(e.id))
    if (fresh.length > 0) await deps.storage.commit(p.accountId, fresh)
    given += fresh.length
    await deps.state.putPeriod({ ...p, given: [...p.given, ...drops.map(d => d.index)] })
  }
  return { given }
}

/** A failed renewal opens `past_due` for the offer's `grace`; with none the period closes (rule 17). */
export async function failRenewal(
  deps: BillingDeps,
  input: { accountId: string; offerId: string; at?: number },
): Promise<PeriodRecord | null> {
  const at = input.at ?? deps.clock.nowMs()
  const open = (await deps.state.listPeriods({ accountId: input.accountId, offerId: input.offerId }))
    .filter(p => p.status === "active")
    .sort((a, b) => b.endAt - a.endAt)[0]
  if (!open) return null
  const next: PeriodRecord =
    open.graceMs > 0
      ? { ...open, status: "past_due", graceEndsAt: open.endAt + open.graceMs }
      : { ...open, status: "closed", closedAt: at, closedReason: "no_grace" }
  await deps.state.putPeriod(next)
  return next
}

/**
 * A subscription that ended at the rail (canceled, or ended unpaid): its open
 * period (`active` or `past_due`) closes at `at` with that reason. The
 * includes already given stay; no other is given, and no renewal is awaited.
 * Null when the offer has no open period for the account.
 */
export async function endSubscription(
  deps: BillingDeps,
  input: { accountId: string; offerId: string; reason: "canceled" | "unpaid"; at?: number },
): Promise<PeriodRecord | null> {
  const at = input.at ?? deps.clock.nowMs()
  const open = (await deps.state.listPeriods({ accountId: input.accountId, offerId: input.offerId }))
    .filter(p => p.status === "active" || p.status === "past_due")
    .sort((a, b) => b.endAt - a.endAt)
  if (open.length === 0) return null
  let last: PeriodRecord | null = null
  for (const p of open) {
    const next: PeriodRecord = { ...p, status: "closed", closedAt: at, closedReason: input.reason }
    await deps.state.putPeriod(next)
    last ??= next
  }
  return last
}

/** Close every `past_due` period whose grace is over (rule 17). */
export async function sweepGrace(deps: BillingDeps, now = deps.clock.nowMs()): Promise<PeriodRecord[]> {
  const closed: PeriodRecord[] = []
  for (const p of await deps.state.listPeriods()) {
    if (p.status === "past_due" && p.graceEndsAt !== undefined && p.graceEndsAt <= now) {
      const next: PeriodRecord = { ...p, status: "closed", closedAt: now, closedReason: "grace_expired" }
      await deps.state.putPeriod(next)
      closed.push(next)
    }
  }
  return closed
}

/** Close a period for a refund or a lost dispute (rule 7): no further include is given. */
export async function closePeriod(
  deps: BillingDeps,
  id: string,
  reason: "refunded" | "disputed",
  at = deps.clock.nowMs(),
): Promise<PeriodRecord | null> {
  const p = await deps.state.getPeriod(id)
  if (!p || p.status === "closed") return p
  const next: PeriodRecord = { ...p, status: "closed", closedAt: at, closedReason: reason }
  await deps.state.putPeriod(next)
  return next
}

/**
 * Reopen a period closed for a refund or a lost dispute, once what was taken
 * back of its payment is below the payment again (a reversed refund, a dispute
 * won after it was lost). The drops missed while it was closed are given by
 * the next `runDueIncludes`. A period closed for another reason stays closed.
 */
export async function reopenPeriod(deps: BillingDeps, id: string): Promise<PeriodRecord | null> {
  const p = await deps.state.getPeriod(id)
  if (!p || p.status !== "closed" || (p.closedReason !== "refunded" && p.closedReason !== "disputed")) return p
  const { closedAt: _at, closedReason: _reason, ...open } = p
  const next: PeriodRecord = { ...open, status: "active" }
  await deps.state.putPeriod(next)
  return next
}

/** Boolean features an account holds at `now`: open periods (grace included) and one-time access. */
export async function activeFeatures(deps: BillingDeps, accountId: string, now = deps.clock.nowMs()): Promise<string[]> {
  const out = new Set<string>()
  for (const p of await deps.state.listPeriods({ accountId })) {
    const live =
      p.status === "active" ? now < p.endAt : p.status === "past_due" ? now < (p.graceEndsAt ?? p.endAt) : false
    if (live) for (const f of p.features) out.add(f)
  }
  for (const a of await deps.state.listAccess(accountId)) if (a.revokedAt === undefined) for (const f of a.features) out.add(f)
  return [...out]
}
