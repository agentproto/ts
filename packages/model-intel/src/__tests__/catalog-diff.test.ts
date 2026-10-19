import { describe, expect, it } from "vitest"
import { diffCatalog } from "../index.js"
import type { CatalogSnapshot } from "../index.js"

function entry(id: string, inputPer1M: number, outputPer1M: number): CatalogSnapshot[string] {
  return { id, inputPer1M, outputPer1M, free: inputPer1M === 0 && outputPer1M === 0 }
}

describe("diffCatalog", () => {
  it("reports all ids as appeared for empty-to-nonempty", () => {
    const next: CatalogSnapshot = { "a-model": entry("a-model", 1, 2), "b-model": entry("b-model", 0, 0) }
    expect(diffCatalog({}, next)).toEqual({
      appeared: ["a-model", "b-model"],
      removed: [],
      priceChanged: [],
      freeToPaid: [],
      paidToFree: [],
    })
  })

  it("reports all ids as removed for nonempty-to-empty", () => {
    const prev: CatalogSnapshot = { "a-model": entry("a-model", 1, 2) }
    expect(diffCatalog(prev, {})).toEqual({
      appeared: [],
      removed: ["a-model"],
      priceChanged: [],
      freeToPaid: [],
      paidToFree: [],
    })
  })

  it("reports a price change on an unrelated-to-free-status id", () => {
    const prev: CatalogSnapshot = { m: entry("m", 3, 15) }
    const next: CatalogSnapshot = { m: entry("m", 3, 12) }
    expect(diffCatalog(prev, next)).toEqual({
      appeared: [],
      removed: [],
      priceChanged: [{ id: "m", prev: { inputPer1M: 3, outputPer1M: 15 }, next: { inputPer1M: 3, outputPer1M: 12 } }],
      freeToPaid: [],
      paidToFree: [],
    })
  })

  it("reports a free-to-paid transition, including the price change", () => {
    const prev: CatalogSnapshot = { m: entry("m", 0, 0) }
    const next: CatalogSnapshot = { m: entry("m", 1, 2) }
    const diff = diffCatalog(prev, next)
    expect(diff.freeToPaid).toEqual(["m"])
    expect(diff.paidToFree).toEqual([])
    expect(diff.priceChanged).toEqual([
      { id: "m", prev: { inputPer1M: 0, outputPer1M: 0 }, next: { inputPer1M: 1, outputPer1M: 2 } },
    ])
  })

  it("reports a paid-to-free transition, including the price change", () => {
    const prev: CatalogSnapshot = { m: entry("m", 1, 2) }
    const next: CatalogSnapshot = { m: entry("m", 0, 0) }
    const diff = diffCatalog(prev, next)
    expect(diff.paidToFree).toEqual(["m"])
    expect(diff.freeToPaid).toEqual([])
    expect(diff.priceChanged).toHaveLength(1)
  })

  it("produces all-empty arrays for identical snapshots", () => {
    const snapshot: CatalogSnapshot = {
      a: entry("a", 1, 2),
      b: entry("b", 0, 0),
    }
    expect(diffCatalog(snapshot, { ...snapshot })).toEqual({
      appeared: [],
      removed: [],
      priceChanged: [],
      freeToPaid: [],
      paidToFree: [],
    })
  })
})
