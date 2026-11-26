/**
 * `usageReport`: what a list of shadow entries says, per category. Pure: it
 * reads entries the host's sink kept and writes nothing. It is the proof used
 * before a host lets a new pricing path debit: the real margin of each
 * category, what was charged, what could not be priced.
 *
 * One entry counts once per event key (a sink that kept a replay twice does not
 * double a line); the last entry of a key wins.
 */
import type { UsageConfig } from "./types.js"
import type { ShadowEntry } from "./shadow.js"

export interface UsageReportLine {
  categoryId: string
  events: number
  units: number
  /** Sum of what was charged, minor units of the primary asset. */
  chargedMinor: number
  /** Sum of the provider cost in the same minor units (exact, before margin). */
  costMinor: number
  /** chargedMinor / costMinor; undefined when the cost is 0. */
  realMargin?: number
  atCost: boolean
}

export interface UsageReport {
  lines: UsageReportLine[]
  totalChargedMinor: number
  totalCostMinor: number
  unpriced: { events: number; byReason: Record<string, number> }
  /** Events and charge per `credentialSource` tag (opaque to the kit); events without a tag are under `""`. */
  byCredentialSource: Record<string, { events: number; chargedMinor: number }>
  /** Categories whose aggregate real margin is under their declared `marginFloor` (at-cost: under 1). Needs `usage`. */
  belowFloor: { categoryId: string; realMargin: number; floor: number }[]
}

const EPS = 1e-9

export function usageReport(entries: readonly ShadowEntry[], usage?: UsageConfig): UsageReport {
  const last = new Map<string, ShadowEntry>()
  for (const e of entries) last.set(e.event.key, e)
  const lines = new Map<string, UsageReportLine>()
  const unpriced: UsageReport["unpriced"] = { events: 0, byReason: {} }
  const bySource: UsageReport["byCredentialSource"] = {}
  let totalCharged = 0
  let totalCost = 0
  for (const e of last.values()) {
    if (e.status === "unpriced") {
      unpriced.events++
      unpriced.byReason[e.reason] = (unpriced.byReason[e.reason] ?? 0) + 1
      continue
    }
    const p = e.price
    const l = lines.get(p.categoryId) ?? { categoryId: p.categoryId, events: 0, units: 0, chargedMinor: 0, costMinor: 0, atCost: p.atCost }
    l.events++
    l.units += e.event.units ?? 1
    l.chargedMinor += p.minor
    l.costMinor += p.costMinor
    totalCost += p.costMinor
    totalCharged += p.minor
    lines.set(p.categoryId, l)
    const src = p.credentialSource ?? ""
    const s = bySource[src] ?? { events: 0, chargedMinor: 0 }
    s.events++
    s.chargedMinor += p.minor
    bySource[src] = s
  }
  const out: UsageReportLine[] = [...lines.values()].map(l => ({ ...l, ...(l.costMinor > 0 ? { realMargin: l.chargedMinor / l.costMinor } : {}) }))
  const belowFloor: UsageReport["belowFloor"] = []
  for (const l of out) {
    const c = usage?.categories.find(x => x.id === l.categoryId)
    const floor = c?.marginFloor ?? (l.atCost ? 1 : undefined)
    if (floor !== undefined && l.realMargin !== undefined && l.realMargin + EPS < floor) belowFloor.push({ categoryId: l.categoryId, realMargin: l.realMargin, floor })
  }
  return { lines: out.sort((a, b) => a.categoryId.localeCompare(b.categoryId)), totalChargedMinor: totalCharged, totalCostMinor: totalCost, unpriced, byCredentialSource: bySource, belowFloor }
}
