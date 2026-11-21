/** Rule 26: the entry rate of a fiat is computed from the anchor and `fx`, never written. */
import type { BillingDefinition } from "./types.js"
import { normalizeCurrency, normalizeRef, roundRatio } from "./model.js"

/** Credits per major unit of `currency`, or null when it is neither the anchor currency nor in `fx`. */
export function entryRatio(def: Pick<BillingDefinition, "anchor" | "fx">, currency: string): number | null {
  const code = normalizeRef(currency).toUpperCase()
  const anchorCur = normalizeCurrency(def.anchor.currency)
  if (code === anchorCur) return roundRatio(def.anchor.creditsPerUnit)
  const fx = Object.entries(def.fx ?? {}).find(([k]) => normalizeCurrency(k) === code)?.[1]
  return fx === undefined ? null : roundRatio(def.anchor.creditsPerUnit * fx)
}
