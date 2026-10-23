/**
 * Catalog watch domain: pure diff of two catalog snapshots.
 * No I/O — mirrors the pure-evaluator pattern of `build.ts`.
 */

export interface CatalogSnapshotEntry {
  /** Catalog model id, e.g. "claude-sonnet-5-5". The snapshot's own key. */
  id: string
  inputPer1M: number
  outputPer1M: number
  /** Derived: true when inputPer1M === 0 && outputPer1M === 0. */
  free: boolean
}

/** Keyed by CatalogSnapshotEntry.id. */
export type CatalogSnapshot = Record<string, CatalogSnapshotEntry>

export interface CatalogPriceChange {
  id: string
  prev: Pick<CatalogSnapshotEntry, "inputPer1M" | "outputPer1M">
  next: Pick<CatalogSnapshotEntry, "inputPer1M" | "outputPer1M">
}

export interface CatalogDiff {
  /** ids present in `next`, absent from `prev`. */
  appeared: string[]
  /** ids present in `prev`, absent from `next`. */
  removed: string[]
  /** same id in both, inputPer1M or outputPer1M differs. Price-only — an id
   *  in `appeared`/`removed` never also appears here. */
  priceChanged: CatalogPriceChange[]
  /** id was free in prev, not free in next (and still present in both —
   *  already counted in priceChanged too if the price itself differs). */
  freeToPaid: string[]
  /** id was not free in prev, free in next. */
  paidToFree: string[]
}

/** Same rule as `isZeroPriced` in `@agentproto/model-catalog`: both token
 *  prices are exactly 0. Kept local because `model-intel` deliberately has no
 *  dependency on the model catalog (and this PR adds no dependency). */
export function isZeroPriced(pricing: {
  inputPer1M: number
  outputPer1M: number
}): boolean {
  return pricing.inputPer1M === 0 && pricing.outputPer1M === 0
}

function isFree(entry: CatalogSnapshotEntry): boolean {
  return isZeroPriced(entry)
}

export function diffCatalog(prev: CatalogSnapshot, next: CatalogSnapshot): CatalogDiff {
  const appeared: string[] = []
  const removed: string[] = []
  const priceChanged: CatalogPriceChange[] = []
  const freeToPaid: string[] = []
  const paidToFree: string[] = []

  for (const id of Object.keys(next)) {
    if (!(id in prev)) appeared.push(id)
  }
  for (const id of Object.keys(prev)) {
    if (!(id in next)) removed.push(id)
  }

  for (const id of Object.keys(next)) {
    const before = prev[id]
    // Object.keys(next) guarantees `after` exists; the guard satisfies noUncheckedIndexedAccess.
    const after = next[id]
    if (!before || !after) continue
    if (before.inputPer1M !== after.inputPer1M || before.outputPer1M !== after.outputPer1M) {
      priceChanged.push({
        id,
        prev: { inputPer1M: before.inputPer1M, outputPer1M: before.outputPer1M },
        next: { inputPer1M: after.inputPer1M, outputPer1M: after.outputPer1M },
      })
    }
    const wasFree = isFree(before)
    const isNowFree = isFree(after)
    if (wasFree && !isNowFree) freeToPaid.push(id)
    if (!wasFree && isNowFree) paidToFree.push(id)
  }

  return {
    appeared: appeared.sort(),
    removed: removed.sort(),
    priceChanged: priceChanged.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    freeToPaid: freeToPaid.sort(),
    paidToFree: paidToFree.sort(),
  }
}
