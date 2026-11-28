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
    expect(
      CollectItem.safeParse({ id: "a", source: "s", kind: "tweet", firstSeenAt: "2026-11-28T10:00:00Z" }).success,
    ).toBe(false)
    expect(
      CollectItem.safeParse({
        id: "a",
        source: "s",
        kind: "post",
        firstSeenAt: "2026-11-28T10:00:00Z",
        subjects: [{ label: "x", provenance: "guess" }],
      }).success,
    ).toBe(false)
  })

  it("never coerces a missing counter to zero", () => {
    const obs = Observation.parse({
      itemId: "x:1",
      measuredAt: "2026-01-01T00:00:00Z",
      metrics: { likes: 3 },
      rawValues: { likes: "3" },
      missing: { reposts: "not_exposed" },
    })
    expect(obs.metrics.likes).toBe(3)
    expect("reposts" in obs.metrics).toBe(false)
    expect(obs.metrics.views).toBeUndefined()
    expect(obs.missing?.reposts).toBe("not_exposed")
    expect(Observation.parse({ itemId: "x:1", measuredAt: "2026-11-28T10:00:00Z" }).metrics).toEqual({})
    expect(
      Observation.safeParse({ itemId: "x:1", measuredAt: "2026-11-28T10:00:00Z", missing: { likes: "zero" } }).success,
    ).toBe(false)
  })

  it("records unknown audience with a reason, never as zero", () => {
    const base = { ref: "x:@h", audience: [] as unknown[] }
    expect(Actor.parse(base).audience).toEqual([])
    const unknown = Actor.safeParse({
      ...base,
      audience: [{ measuredAt: "2026-11-28T10:00:00Z", kind: "followers", unknown: "not_fetched" }],
    })
    expect(unknown.success).toBe(true)
    const known = Actor.safeParse({
      ...base,
      audience: [{ measuredAt: "2026-11-28T10:00:00Z", kind: "karma", value: 120 }],
    })
    expect(known.success).toBe(true)
    expect(
      Actor.safeParse({ ...base, audience: [{ measuredAt: "2026-11-28T10:00:00Z", kind: "followers" }] }).success,
    ).toBe(false)
    expect(
      Actor.safeParse({
        ...base,
        audience: [{ measuredAt: "2026-11-28T10:00:00Z", kind: "followers", value: 0, unknown: "blocked" }],
      }).success,
    ).toBe(false)
    expect(
      Actor.safeParse({ ...base, audience: [{ measuredAt: "2026-11-28T10:00:00Z", kind: "fans", value: 1 }] }).success,
    ).toBe(false)
  })

  it("validates pickups", () => {
    const pickup = {
      itemId: "web:a",
      kind: "media_pickup",
      pickupUrl: "https://example.com/b",
      relation: "citation",
      evidence: { outboundLink: "https://example.com/a", rawRef: "raw/ab" },
      method: "link",
      verified: true,
      firstSeenAt: "2026-11-28T10:00:00Z",
      measuredAt: "2026-11-28T10:00:00Z",
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
    expect(Coverage.parse({ cells: [cell] })).toEqual({ cells: [cell] })
    expect(Coverage.safeParse({ cells: [{ ...cell, items: -1 }] }).success).toBe(false)
    const report = RunReport.parse({
      runId: "r1",
      startedAt: "2026-11-28T10:00:00Z",
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
          coverage: { cells: [cell] },
        },
      ],
      coverage: { cells: [cell] },
    })
    expect(report.connectors[0]?.status).toBe("ok")
    expect(report.connectors[0]?.coverage).toEqual({ cells: [cell] })
    expect(report.coverage).toEqual({ cells: [cell] })
  })

  it("requires full timestamps for measuredAt and firstSeenAt, allows a day for publishedAt", () => {
    expect(Observation.safeParse({ itemId: "x:1", measuredAt: "2026-11-28" }).success).toBe(false)
    expect(Observation.safeParse({ itemId: "x:1", measuredAt: "2026-11-28T10:00:00+01:00" }).success).toBe(true)
    expect(
      Actor.safeParse({ ref: "x:@h", audience: [{ measuredAt: "2026-11-28", kind: "followers", value: 1 }] }).success,
    ).toBe(false)
    const base = { id: "web:a", source: "web", kind: "article", firstSeenAt: "2026-11-28T10:00:00Z" }
    expect(CollectItem.safeParse({ ...base, firstSeenAt: "2026-11-28" }).success).toBe(false)
    expect(CollectItem.safeParse({ ...base, publishedAt: "2026-11-28" }).success).toBe(true)
    expect(CollectItem.safeParse({ ...base, postedAt: "2026-11-28T10:00:00Z" }).success).toBe(true)
    expect(CollectItem.safeParse({ ...base, publishedAt: "yesterday" }).success).toBe(false)
    expect(Actor.safeParse({ ref: "x:@h", accountCreatedAt: "2020-01-02" }).success).toBe(true)
    expect(Actor.safeParse({ ref: "x:@h", accountCreatedAt: "soon" }).success).toBe(false)
  })

  it("keeps Pickup.verified consistent with its method", () => {
    const base = {
      itemId: "web:a",
      kind: "media_pickup",
      relation: "citation",
      evidence: { excerpt: "quoted", rawRef: "raw/ab" },
      firstSeenAt: "2026-11-28T10:00:00Z",
      measuredAt: "2026-11-28T10:00:00Z",
    }
    for (const method of ["link", "content_id", "declared"]) {
      expect(Pickup.safeParse({ ...base, method, verified: true }).success).toBe(true)
      expect(Pickup.safeParse({ ...base, method, verified: false }).success).toBe(false)
    }
    for (const method of ["near_text", "legacy_flag"]) {
      expect(Pickup.safeParse({ ...base, method, verified: false }).success).toBe(true)
      expect(Pickup.safeParse({ ...base, method, verified: true }).success).toBe(false)
    }
  })

  it("requires evidence and a raw pointer for link and content_id pickups, some evidence for declared", () => {
    const base = {
      itemId: "web:a",
      kind: "media_pickup",
      relation: "citation",
      firstSeenAt: "2026-11-28T10:00:00Z",
      measuredAt: "2026-11-28T10:00:00Z",
    }
    for (const method of ["link", "content_id"]) {
      const p = { ...base, method, verified: true }
      expect(Pickup.safeParse({ ...p, evidence: { excerpt: "q", rawRef: "r" } }).success).toBe(true)
      expect(Pickup.safeParse({ ...p, evidence: {} }).success).toBe(false)
      expect(Pickup.safeParse({ ...p, evidence: { rawRef: "r" } }).success).toBe(false)
      expect(Pickup.safeParse({ ...p, evidence: { excerpt: "q" } }).success).toBe(false)
    }
    const declared = { ...base, method: "declared", verified: true }
    expect(Pickup.safeParse({ ...declared, evidence: {} }).success).toBe(false)
    expect(Pickup.safeParse({ ...declared, evidence: { excerpt: "q" } }).success).toBe(true)
    expect(Pickup.safeParse({ ...declared, evidence: { outboundLink: "https://example.com/a" } }).success).toBe(true)
    expect(Pickup.safeParse({ ...declared, evidence: {}, outlet: "example.com" }).success).toBe(true)
  })

  it("requires a subject label on recipe queries", () => {
    expect(Recipe.safeParse({ sources: [{ connector: "rss", queries: [{ text: "q" }] }] }).success).toBe(false)
  })

  it("rejects a counter that is both measured and missing, and a raw value without a metric", () => {
    const at = "2026-11-28T10:00:00Z"
    expect(
      Observation.safeParse({ itemId: "x:1", measuredAt: at, metrics: { likes: 1 }, missing: { likes: "hidden" } })
        .success,
    ).toBe(false)
    expect(
      Observation.safeParse({
        itemId: "x:1",
        measuredAt: at,
        metrics: { views: 873400 },
        rawValues: { views: "873.4K" },
      }).success,
    ).toBe(true)
    expect(Observation.safeParse({ itemId: "x:1", measuredAt: at, rawValues: { views: "873.4K" } }).success).toBe(false)
  })
})
