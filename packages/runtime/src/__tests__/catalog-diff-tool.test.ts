/**
 * Coverage for the `catalog_diff` core (`readCatalogDiff`) — everything
 * injected (catalog source + store fakes), never touching the real
 * `~/.agentproto` file or `LLM_PRICING_CATALOG`.
 */
import { describe, expect, it } from "vitest"
import type { CatalogDiff, CatalogSnapshot } from "../catalog-diff-stub.js"
import { readCatalogDiff } from "../catalog-diff-tool.js"

function snap(entries: Record<string, [number, number]>): CatalogSnapshot {
  const out: CatalogSnapshot = {}
  for (const [id, [inputPer1M, outputPer1M]] of Object.entries(entries)) {
    out[id] = { id, inputPer1M, outputPer1M, free: inputPer1M === 0 && outputPer1M === 0 }
  }
  return out
}

describe("readCatalogDiff", () => {
  it("first call ever (empty stored snapshot) → everything appears", async () => {
    const recorded: CatalogSnapshot[] = []
    const result = await readCatalogDiff({
      getCurrentCatalog: () => snap({ "gpt-a": [1, 2], "gpt-b": [0, 0] }),
      loadStore: async () => ({ version: 1, snapshot: {}, asOf: "1970-01-01T00:00:00.000Z" }),
      recordStore: async (snapshot) => {
        recorded.push(snapshot)
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.diff).toEqual({
      appeared: ["gpt-a", "gpt-b"],
      removed: [],
      priceChanged: [],
      freeToPaid: [],
      paidToFree: [],
    } satisfies CatalogDiff)
    expect(result.previousAsOf).toBeUndefined()
    expect(result.asOf).toBeTruthy()
    expect(recorded).toHaveLength(1)
  })

  it("second call with no catalog change → all-empty diff", async () => {
    const catalog = snap({ "gpt-a": [1, 2] })
    const result = await readCatalogDiff({
      getCurrentCatalog: () => catalog,
      loadStore: async () => ({
        version: 1,
        snapshot: catalog,
        asOf: "2026-10-19T00:00:00.000Z",
      }),
      recordStore: async () => {},
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.diff).toEqual({
      appeared: [],
      removed: [],
      priceChanged: [],
      freeToPaid: [],
      paidToFree: [],
    })
    expect(result.previousAsOf).toBe("2026-10-19T00:00:00.000Z")
  })

  it("second call after a price change → priceChanged, freeToPaid, removed, appeared", async () => {
    const recorded: CatalogSnapshot[] = []
    const stored = snap({
      "gpt-a": [1, 2],
      "gpt-free": [0, 0],
      "gpt-gone": [3, 4],
    })
    const result = await readCatalogDiff({
      getCurrentCatalog: () =>
        snap({ "gpt-a": [2, 3], "gpt-free": [5, 6], "gpt-new": [0, 0] }),
      loadStore: async () => ({
        version: 1,
        snapshot: stored,
        asOf: "2026-10-19T00:00:00.000Z",
      }),
      recordStore: async (snapshot) => {
        recorded.push(snapshot)
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.diff.appeared).toEqual(["gpt-new"])
    expect(result.diff.removed).toEqual(["gpt-gone"])
    expect(result.diff.priceChanged).toEqual([
      { id: "gpt-a", prev: { inputPer1M: 1, outputPer1M: 2 }, next: { inputPer1M: 2, outputPer1M: 3 } },
      { id: "gpt-free", prev: { inputPer1M: 0, outputPer1M: 0 }, next: { inputPer1M: 5, outputPer1M: 6 } },
    ])
    expect(result.diff.freeToPaid).toEqual(["gpt-free"])
    expect(result.diff.paidToFree).toEqual([])
    expect(recorded).toHaveLength(1)
    expect(Object.keys(recorded[0]!)).toEqual(["gpt-a", "gpt-free", "gpt-new"])
  })

  it("getCurrentCatalog throwing → explicit ok:false, never throws", async () => {
    const result = await readCatalogDiff({
      getCurrentCatalog: () => {
        throw new Error("boom")
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain("boom")
  })

  it("store failure → explicit ok:false, never throws", async () => {
    const result = await readCatalogDiff({
      getCurrentCatalog: () => snap({ "gpt-a": [1, 2] }),
      loadStore: async () => {
        throw new Error("disk full")
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain("disk full")
  })
})
