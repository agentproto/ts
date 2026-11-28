import { describe, expect, it } from "vitest"
import { computeCoverage, defineConnector, memoryStore } from "../index"
import { T, item } from "./helpers"

const connector = (counters: Array<{ name: "points" | "likes"; primary?: boolean }>) =>
  defineConnector({
    id: "hn",
    version: "1",
    transports: ["http"],
    counters: counters.map((c) => ({ ...c, unit: "count", scope: "root" as const })),
    plan: () => [],
    fetch: async () => ({ raws: [] }),
    parse: () => ({}),
  })

describe("computeCoverage", () => {
  it("counts every column on a known set, eligible included", async () => {
    const s = memoryStore()
    const subj = [{ label: "ai", provenance: "query" as const }]
    // 1: complete. 2: no audience. 3: no postedAt. 4: shares content with 5. 5: no author, no metrics.
    await s.upsertItem(item(1, { subjects: subj, format: "post", language: "en", authorRef: "hn:ann", postedAt: "2026-11-01", contentId: "x1" }))
    await s.upsertItem(item(2, { subjects: subj, format: "post", language: "en", authorRef: "hn:bob", postedAt: "2026-11-01", contentId: "x2" }))
    await s.upsertItem(item(3, { subjects: subj, format: "post", language: "en", authorRef: "hn:ann", contentId: "x3" }))
    await s.upsertItem(item(4, { subjects: subj, format: "post", language: "en", authorRef: "hn:ann", postedAt: "2026-11-01", contentId: "dup" }))
    await s.upsertItem(item(5, { format: "post", contentId: "dup" }))
    for (const n of [1, 2, 3, 4]) await s.appendObservation({ itemId: `hn:${n}`, measuredAt: T, metrics: { points: n } })
    await s.appendObservation({ itemId: "hn:5", measuredAt: T, metrics: {} })
    await s.appendActor({ ref: "hn:ann", audience: [{ measuredAt: T, kind: "followers", value: 10 }] })
    await s.appendActor({ ref: "hn:bob", audience: [{ measuredAt: T, kind: "karma", value: 99 }] })

    const { cells } = await computeCoverage(s, [connector([{ name: "points", primary: true }])])
    expect(cells).toHaveLength(2)
    const main = cells.find((c) => c.subject === "ai")!
    expect(main).toEqual({
      platform: "hn",
      format: "post",
      language: "en",
      subject: "ai",
      items: 4,
      withAuthorAudience: 3, // ann x3; bob has karma only
      withPrimaryMetric: 4,
      withAge: 3,
      withAuthorId: 4,
      withUniqueContent: 3, // item 4 shares "dup" with item 5
      eligible: 2, // items 1 and 4
    })
    const none = cells.find((c) => c.subject === "none")!
    expect(none).toMatchObject({ language: "unknown", items: 1, withPrimaryMetric: 0, withUniqueContent: 0, eligible: 0 })
  })

  it("never counts a primary metric when none is declared, or when no connector is known", async () => {
    const s = memoryStore()
    await s.upsertItem(item(1))
    await s.appendObservation({ itemId: "hn:1", measuredAt: T, metrics: { likes: 1 } })
    expect((await computeCoverage(s, [connector([{ name: "likes" }])])).cells[0]!.withPrimaryMetric).toBe(0)
    expect((await computeCoverage(s)).cells[0]!.withPrimaryMetric).toBe(0)
    expect((await computeCoverage(s, [connector([{ name: "likes", primary: true }])])).cells[0]!.withPrimaryMetric).toBe(1)
  })
})
