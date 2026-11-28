import { describe, expect, it } from "vitest"
import { Actor, CollectItem, Coverage, Observation, Pickup, Recipe, RunReport, STORE_SCHEMA_VERSION } from "../index"

describe("schemas", () => {
  it("exposes a store schema version", () => {
    expect(Number.isInteger(STORE_SCHEMA_VERSION)).toBe(true)
  })

  it("accepts an item with no subject and no audience", () => {
    const item = CollectItem.parse({
      id: "web:abc",
      source: "web",
      kind: "article",
      firstSeenAt: "2026-01-01T00:00:00Z",
    })
    expect(item.subjects).toEqual([])
    expect(item.authorRef).toBeUndefined()
  })

  it("validates subjects and kinds", () => {
    const ok = CollectItem.safeParse({
      id: "hackernews:1",
      source: "hackernews",
      kind: "submission",
      firstSeenAt: "2026-01-01T00:00:00Z",
      subjects: [{ label: "topic", provenance: "classifier", classifier: { name: "c", version: "1" } }],
      links: { target: "web:def" },
    })
    expect(ok.success).toBe(true)
    expect(CollectItem.safeParse({ id: "a", source: "s", kind: "tweet", firstSeenAt: "t" }).success).toBe(false)
    expect(
      CollectItem.safeParse({
        id: "a",
        source: "s",
        kind: "post",
        firstSeenAt: "t",
        subjects: [{ label: "x", provenance: "guess" }],
      }).success,
    ).toBe(false)
  })

  it("never coerces a missing counter to zero", () => {
    const obs = Observation.parse({
      itemId: "x:1",
      measuredAt: "2026-01-01T00:00:00Z",
      metrics: { likes: 3 },
      rawValues: { views: "873.4K" },
      missing: { reposts: "not_exposed" },
    })
    expect(obs.metrics.likes).toBe(3)
    expect("reposts" in obs.metrics).toBe(false)
    expect(obs.metrics.views).toBeUndefined()
    expect(Observation.parse({ itemId: "x:1", measuredAt: "t" }).metrics).toEqual({})
    expect(Observation.safeParse({ itemId: "x:1", measuredAt: "t", missing: { likes: "zero" } }).success).toBe(false)
  })

  it("records unknown audience with a reason, never as zero", () => {
    const base = { ref: "x:@h", audience: [] as unknown[] }
    expect(Actor.parse(base).audience).toEqual([])
    const unknown = Actor.safeParse({
      ...base,
      audience: [{ measuredAt: "t", kind: "followers", unknown: "not_fetched" }],
    })
    expect(unknown.success).toBe(true)
    const known = Actor.safeParse({
      ...base,
      audience: [{ measuredAt: "t", kind: "karma", value: 120 }],
    })
    expect(known.success).toBe(true)
    expect(Actor.safeParse({ ...base, audience: [{ measuredAt: "t", kind: "followers" }] }).success).toBe(false)
    expect(
      Actor.safeParse({ ...base, audience: [{ measuredAt: "t", kind: "followers", value: 0, unknown: "blocked" }] })
        .success,
    ).toBe(false)
    expect(Actor.safeParse({ ...base, audience: [{ measuredAt: "t", kind: "fans", value: 1 }] }).success).toBe(false)
  })

  it("validates pickups", () => {
    const pickup = {
      itemId: "web:a",
      kind: "media_pickup",
      pickupUrl: "https://example.com/b",
      relation: "citation",
      evidence: { outboundLink: "https://example.com/a" },
      method: "link",
      verified: true,
      firstSeenAt: "t",
      measuredAt: "t",
    }
    expect(Pickup.safeParse(pickup).success).toBe(true)
    expect(Pickup.safeParse({ ...pickup, method: "guess" }).success).toBe(false)
    expect(Pickup.safeParse({ ...pickup, evidence: { similarity: 2 } }).success).toBe(false)
  })

  it("validates a recipe and defaults workers to 8", () => {
    const recipe = Recipe.parse({ sources: [{ connector: "rss", queries: [{ text: "q", subject: "s" }] }] })
    expect(recipe.workers).toBe(8)
    expect(Recipe.safeParse({ sources: [] }).success).toBe(false)
  })

  it("validates a run report with coverage", () => {
    const cell = {
      platform: "web",
      format: "long article",
      language: "en",
      subject: "s",
      items: 3,
      withAuthorAudience: 1,
      withPrimaryMetric: 2,
      withAge: 3,
      withAuthorId: 3,
      withUniqueContent: 3,
      eligible: 1,
    }
    expect(Coverage.safeParse({ cells: [cell] }).success).toBe(true)
    expect(Coverage.safeParse({ cells: [{ ...cell, items: -1 }] }).success).toBe(false)
    const report = RunReport.parse({
      runId: "r1",
      startedAt: "t",
      connectors: [
        {
          connector: "web",
          tasks: { planned: 2, done: 1, failed: 1, skipped: 0 },
          newItems: 1,
          observations: 1,
          duplicates: 0,
          failures: { blocked: 1 },
          escalations: [{ from: "http", to: "browser", count: 1 }],
          durationMs: 10,
        },
      ],
      coverage: { cells: [cell] },
    })
    expect(report.connectors[0]?.status).toBe("ok")
  })
})
