/**
 * Free credits (AIP-BILLING `grants`, rules 15 and 21).
 *
 * Every write has a deterministic key `grant:<id>:<suffix>`, so a grant that
 * fires twice for the same account and period writes once, and two grants never
 * collide. `top-up` replaces the unspent remainder of the previous drop in the
 * partition: the remainder is burned and `amount` is minted.
 */
import { fold } from "@agentproto/wallet"
import { addDuration } from "./model.js"
import { serial } from "./payment.js"
import type { BillingDeps, CauseEvent } from "./ports.js"
import type { Grant } from "./types.js"

/** Calendar fields of an instant in an IANA zone (UTC by default). */
function zoned(at: number, tz = "UTC"): { y: number; m: number; d: number; dow: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(new Date(at))
  const get = (t: string) => parts.find(p => p.type === t)!.value
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"))
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), dow }
}

/** ISO 8601 week, `2026-W47`. */
function isoWeek(y: number, m: number, d: number): string {
  const date = new Date(Date.UTC(y, m - 1, d))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

const pad = (n: number) => String(n).padStart(2, "0")

/**
 * The `{period}` token of a scheduled grant at `at`: the ISO week for a weekly
 * schedule, `YYYY-MM` for a monthly one, a day for a daily one, a year for a
 * yearly one. The frequency is read from the cron fields or from `FREQ=` of an
 * RRULE, in the zone the trigger names (UTC by default).
 */
export function periodKey(trigger: Grant["trigger"], at: number): string {
  if (trigger.kind !== "cron" && trigger.kind !== "calendar") throw new Error(`trigger '${trigger.kind}' has no period`)
  const z = zoned(at, trigger.timezone ?? "UTC")
  let freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"
  if (trigger.kind === "calendar") {
    const f = /FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/.exec(trigger.rrule)?.[1]
    if (!f) throw new Error(`rrule '${trigger.rrule}' has no supported FREQ`)
    freq = f as typeof freq
  } else {
    const [, , dom = "*", month = "*", dow = "*"] = trigger.cron.trim().split(/\s+/)
    freq = dow !== "*" ? "WEEKLY" : month !== "*" && dom !== "*" ? "YEARLY" : dom !== "*" ? "MONTHLY" : "DAILY"
  }
  switch (freq) {
    case "WEEKLY":
      return isoWeek(z.y, z.m, z.d)
    case "MONTHLY":
      return `${z.y}-${pad(z.m)}`
    case "YEARLY":
      return String(z.y)
    default:
      return `${z.y}-${pad(z.m)}-${pad(z.d)}`
  }
}

export type AmountStrategy = (ctx: GrantContext) => number

export interface GrantContext {
  accountId: string
  at: number
  /** Offer ids the account holds an open period or access for. Empty means a free account. */
  activeOffers: readonly string[]
  /** Amount for `fromContext`, in minor units. */
  contextAmount?: number
  /** Explicit `{period}` for event and manual grants. */
  period?: string
  strategies?: Readonly<Record<string, AmountStrategy>>
}

/** Key of the grant for an account: `grant:<id>:<suffix>` (rule 15). */
export function grantKey(grant: Grant, accountId: string, period?: string): string {
  const needsPeriod = grant.key.includes("{period}")
  if (needsPeriod && period === undefined) throw new Error(`grant '${grant.id}' needs a {period}`)
  return `grant:${grant.id}:${grant.key.replace("{account}", accountId).replace("{period}", period ?? "")}`
}

export function eligible(grant: Grant, activeOffers: readonly string[]): boolean {
  const plans = grant.eligible?.plans
  if (!plans) return true
  return plans.some(p => (p === "none" ? activeOffers.length === 0 : activeOffers.includes(p)))
}

/** Apply one grant for one account, once per key. Returns the minted amount, 0 when skipped. */
export async function applyGrant(deps: BillingDeps, grantId: string, ctx: GrantContext): Promise<{ status: "applied" | "replayed" | "ineligible"; minted: number; key?: string }> {
  const grant = deps.manifest.grants?.find(g => g.id === grantId)
  if (!grant) throw new Error(`unknown grant '${grantId}'`)
  if (!eligible(grant, ctx.activeOffers)) return { status: "ineligible", minted: 0 }
  const period = ctx.period ?? (grant.trigger.kind === "cron" || grant.trigger.kind === "calendar" ? periodKey(grant.trigger, ctx.at) : undefined)
  const key = grantKey(grant, ctx.accountId, period)
  const amount =
    "fixedMinor" in grant.amount
      ? grant.amount.fixedMinor
      : "fromContext" in grant.amount
        ? (ctx.contextAmount ?? 0)
        : (ctx.strategies?.[grant.amount.strategy]?.(ctx) ??
          (() => {
            throw new Error(`grant strategy '${grant.amount.strategy}' is not registered`)
          })())
  if (!Number.isInteger(amount) || amount <= 0) return { status: "ineligible", minted: 0, key }
  return serial(key, async () => {
    const events = (await deps.storage.loadEvents(ctx.accountId)) as CauseEvent[]
    if (events.some(e => e.id === `${key}:mint`)) return { status: "replayed" as const, minted: 0, key }
    const part = deps.manifest.derived.partitions.get(grant.partition)
    const out: CauseEvent[] = []
    if ((grant.mode ?? "add") === "top-up") {
      for (const l of fold(events, ctx.at)) {
        if (l.partitionId === grant.partition && l.remaining > 0 && !(l.expiresAt !== undefined && l.expiresAt <= ctx.at)) {
          out.push({ id: `${key}:wipe:${l.id}`, accountId: ctx.accountId, kind: "burn", asset: l.asset, partitionId: l.partitionId, restriction: l.restriction, amount: l.remaining - l.reserved, lotId: l.id, occurredAt: ctx.at, cause: key, origin: "top-up" })
        }
      }
    }
    const spec = grant.expires
    const expiresAt = spec && "after" in spec ? addDuration(ctx.at, spec.after) : part?.defaultTtlMs !== undefined ? ctx.at + part.defaultTtlMs : undefined
    out.push({ id: `${key}:mint`, accountId: ctx.accountId, kind: "mint", asset: part?.asset ?? deps.manifest.primaryAsset, partitionId: grant.partition, restriction: part?.restriction ?? [], amount, lotId: `${key}:mint`, ...(expiresAt !== undefined ? { expiresAt } : {}), occurredAt: ctx.at, cause: key, origin: "grant" })
    await deps.storage.commit(ctx.accountId, out)
    return { status: "applied" as const, minted: amount, key }
  })
}
