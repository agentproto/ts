// STUB: supervisor will replace this import with "@agentproto/model-intel"
// once that package's own catalog-diff.ts is merged. Keep the exported
// names/shapes identical to that contract.

export interface CatalogSnapshotEntry {
  id: string
  inputPer1M: number
  outputPer1M: number
  free: boolean
}
export type CatalogSnapshot = Record<string, CatalogSnapshotEntry>
export interface CatalogPriceChange {
  id: string
  prev: Pick<CatalogSnapshotEntry, "inputPer1M" | "outputPer1M">
  next: Pick<CatalogSnapshotEntry, "inputPer1M" | "outputPer1M">
}
export interface CatalogDiff {
  appeared: string[]
  removed: string[]
  priceChanged: CatalogPriceChange[]
  freeToPaid: string[]
  paidToFree: string[]
}

export function diffCatalog(prev: CatalogSnapshot, next: CatalogSnapshot): CatalogDiff {
  const appeared: string[] = []
  const removed: string[] = []
  const priceChanged: CatalogPriceChange[] = []
  const freeToPaid: string[] = []
  const paidToFree: string[] = []

  for (const id of Object.keys(prev).sort()) {
    if (!(id in next)) removed.push(id)
  }
  for (const [id, after] of Object.entries(next).sort(([a], [b]) => a.localeCompare(b))) {
    const before = prev[id]
    if (!before) {
      appeared.push(id)
      continue
    }
    if (before.inputPer1M === after.inputPer1M && before.outputPer1M === after.outputPer1M) {
      continue
    }
    priceChanged.push({
      id,
      prev: { inputPer1M: before.inputPer1M, outputPer1M: before.outputPer1M },
      next: { inputPer1M: after.inputPer1M, outputPer1M: after.outputPer1M },
    })
    if (before.free && !after.free) freeToPaid.push(id)
    if (!before.free && after.free) paidToFree.push(id)
  }

  return { appeared, removed, priceChanged, freeToPaid, paidToFree }
}
