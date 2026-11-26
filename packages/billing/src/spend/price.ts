/**
 * `price`: turn a metered event into minor units of the primary asset.
 *
 *   minor = max(floorMinor, ceil(cost x entryRatio(currency) x margin x 10^decimals))
 *
 * The rate is never written in a category: `entryRatio` derives credits per
 * unit of any currency from the manifest's `anchor` (and `fx`), so one field
 * moves every category. A category that says `at-cost` is margin 1 and
 * `defaults.margin` never overrides it (an event cannot carry a margin at all).
 * Margins and floors are the host's configuration: the kit has no value of its
 * own for either (floor 0, margin 1). A fractional minor amount rounds up.
 * An event with no price fails closed (`UnpricedUsageError`); it is never free
 * by accident.
 */
import type { BillingHandle } from "../define-billing-manifest.js"
import { entryRatio } from "../rate.js"
import { normalizeCurrency } from "../model.js"
import { UnpricedUsageError, type PriceBook, type PriceResult, type ProviderCost, type UsageCategory, type UsageConfig, type UsageEvent } from "./types.js"

export interface PricerDeps {
  manifest: BillingHandle
  usage: UsageConfig
  priceBook?: PriceBook
}

export interface Pricer {
  price(event: UsageEvent): PriceResult
  /** The category an event falls in, or null. */
  categoryOf(event: UsageEvent): UsageCategory | null
  readonly usage: UsageConfig
}

const EPS = 1e-9

const specificity = (c: UsageCategory): number => Object.values(c.match ?? {}).filter(v => v !== undefined).length

function matches(c: UsageCategory, e: UsageEvent): boolean {
  const m = c.match ?? {}
  return (["kind", "model", "channel", "op"] as const).every(k => m[k] === undefined || m[k] === e[k])
}

/** Problems that make a usage config unusable against its manifest. Empty = fine. */
export function usageProblems(manifest: Pick<BillingHandle, "anchor" | "fx">, usage: UsageConfig): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const c of usage.categories) {
    if (seen.has(c.id)) out.push(`duplicate category '${c.id}'`)
    seen.add(c.id)
    if (c.margin === "at-cost" && c.marginFloor !== undefined && c.marginFloor > 1) out.push(`category '${c.id}': at-cost cannot have a marginFloor above 1`)
    if (typeof c.margin === "number" && c.margin <= 0) out.push(`category '${c.id}': margin must be positive`)
    if (c.floorMinor !== undefined && (!Number.isInteger(c.floorMinor) || c.floorMinor < 0)) out.push(`category '${c.id}': floorMinor must be a non-negative integer`)
    if (c.cost.source === "fixed") {
      if (!(Number.isFinite(c.cost.amount) && c.cost.amount >= 0)) out.push(`category '${c.id}': a fixed cost must be a non-negative number`)
      if (entryRatio(manifest, c.cost.currency) === null) out.push(`category '${c.id}': currency '${c.cost.currency}' is neither the anchor currency nor in fx`)
    }
  }
  return out
}

export function createPricer(deps: PricerDeps): Pricer {
  const problems = usageProblems(deps.manifest, deps.usage)
  if (problems.length > 0) throw new Error(`invalid usage config: ${problems.join("; ")}`)
  const decimals = deps.manifest.derived.assets.get(deps.manifest.primaryAsset)?.decimals
  if (decimals === undefined) throw new Error(`primary asset '${deps.manifest.primaryAsset}' is not declared`)
  const scale = 10 ** decimals
  const ordered = [...deps.usage.categories].sort((a, b) => specificity(b) - specificity(a))
  const defaults = deps.usage.defaults ?? {}

  const categoryOf = (event: UsageEvent): UsageCategory | null => ordered.find(c => matches(c, event)) ?? null

  function costOf(c: UsageCategory, e: UsageEvent, units: number): ProviderCost | null {
    switch (c.cost.source) {
      case "measured":
        return e.providerCost ?? null
      case "fixed":
        return { amount: c.cost.amount * units, currency: c.cost.currency }
      case "catalog":
        return deps.priceBook?.cost(e) ?? null
    }
  }

  return {
    usage: deps.usage,
    categoryOf,
    price(event) {
      const units = event.units ?? 1
      if (!Number.isFinite(units) || units < 0) throw new UnpricedUsageError("invalid-units", `units must be a non-negative number, got ${units}`)
      const c = categoryOf(event)
      if (!c) throw new UnpricedUsageError("no-category", `no usage category matches kind '${event.kind}'`)
      const atCost = c.margin === "at-cost"
      const margin: number = c.margin === "at-cost" ? 1 : (c.margin ?? defaults.margin ?? 1)
      const floor = c.floorMinor ?? defaults.floorMinor ?? 0
      const cost = costOf(c, event, units)
      if (!cost) throw new UnpricedUsageError("no-cost", `category '${c.id}' has no cost for this event (${c.cost.source})`)
      if (!Number.isFinite(cost.amount) || cost.amount < 0) throw new UnpricedUsageError("invalid-cost", `category '${c.id}': the cost must be a non-negative number, got ${cost.amount}`)
      const ratio = entryRatio(deps.manifest, normalizeCurrency(cost.currency))
      if (ratio === null) throw new UnpricedUsageError("unknown-currency", `currency '${cost.currency}' is neither the anchor currency nor in fx`)
      const costMinor = cost.amount * ratio * scale
      const minor = Math.max(floor, Math.ceil(costMinor * margin - EPS))
      if (!Number.isFinite(minor)) throw new UnpricedUsageError("invalid-cost", `category '${c.id}': the price is not a finite number`)
      return { minor, categoryId: c.id, margin, atCost, costMinor, realMargin: costMinor > 0 ? minor / costMinor : undefined, ...(event.credentialSource !== undefined ? { credentialSource: event.credentialSource } : {}) }
    },
  }
}

/**
 * Throws when a category sells under its `marginFloor` on any of `samples`
 * (the CI check that generalises a fixed margin floor to every category).
 * `at-cost` categories sell at margin 1 and are checked against 1.
 */
export function assertMarginFloors(pricer: Pricer, samples: readonly UsageEvent[]): void {
  const bad: string[] = []
  for (const e of samples) {
    const c = pricer.categoryOf(e)
    if (!c) continue
    const r = pricer.price(e)
    const floor = c.marginFloor ?? (r.atCost ? 1 : undefined)
    if (floor === undefined || r.realMargin === undefined) continue
    if (r.realMargin + EPS < floor) bad.push(`'${c.id}' sells at ${r.realMargin.toFixed(3)} x cost, under its floor ${floor}`)
  }
  if (bad.length > 0) throw new Error(`margin floor violated: ${bad.join("; ")}`)
}
