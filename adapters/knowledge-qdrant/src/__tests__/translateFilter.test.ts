/**
 * Qdrant filter translation — the CorpusFilter → Qdrant payload-filter
 * translation that lets corpus-aware queries reach the backing engine without
 * ad-hoc string surgery.
 *
 * Lifted VERBATIM from the studio suite
 * (`packages/integration/knowledge/src/providers/qdrant/__tests__/translateFilter.test.ts`)
 * — the only change is the import path (`../adapter`). The translation itself
 * is unaffected by the `guildId → tenantId` rename (that scope is applied by
 * `withTenantScope`, not `translateFilter`).
 */

import { describe, expect, it } from "vitest"
import { translateFilter } from "../adapter.js"

describe("translateFilter (CorpusFilter → Qdrant)", () => {
  it("returns undefined for undefined input (no filter clause sent)", () => {
    expect(translateFilter(undefined)).toBeUndefined()
  })

  it("returns undefined for empty record (no clauses)", () => {
    expect(translateFilter({})).toBeUndefined()
  })

  it("passes through a hand-crafted Qdrant filter verbatim", () => {
    const handcrafted = {
      must: [{ key: "foo", match: { value: "bar" } }],
    }
    expect(translateFilter(handcrafted)).toEqual(handcrafted)
  })

  it("translates a single status value to a match clause", () => {
    expect(translateFilter({ status: "active" })).toEqual({
      must: [{ key: "metadata.corpus.status", match: { value: "active" } }],
    })
  })

  it("translates a status array to a match-any clause", () => {
    expect(translateFilter({ status: ["active", "deprecated"] })).toEqual({
      must: [
        {
          key: "metadata.corpus.status",
          match: { any: ["active", "deprecated"] },
        },
      ],
    })
  })

  it("translates minQualityScore to a range gte clause", () => {
    expect(translateFilter({ minQualityScore: 4.0 })).toEqual({
      must: [{ key: "metadata.corpus.qualityScore", range: { gte: 4.0 } }],
    })
  })

  it("translates maxRiskScore to a range lte clause", () => {
    expect(translateFilter({ maxRiskScore: 1.5 })).toEqual({
      must: [{ key: "metadata.corpus.riskScore", range: { lte: 1.5 } }],
    })
  })

  it("translates mentionedSince to a range gte on temporal.lastSeen (epoch ms)", () => {
    const since = "2026-01-01T00:00:00Z"
    const result = translateFilter({ mentionedSince: since })
    expect(result).toEqual({
      must: [
        {
          key: "metadata.corpus.temporal.lastSeen",
          range: { gte: Date.parse(since) },
        },
      ],
    })
  })

  it("composes multiple corpus filter facets into one must[] array", () => {
    expect(
      translateFilter({
        status: "active",
        domain: ["marketing"],
        minQualityScore: 4.0,
        maxRiskScore: 1.5,
      }),
    ).toEqual({
      must: [
        { key: "metadata.corpus.status", match: { value: "active" } },
        { key: "metadata.corpus.domain", match: { any: ["marketing"] } },
        { key: "metadata.corpus.qualityScore", range: { gte: 4.0 } },
        { key: "metadata.corpus.riskScore", range: { lte: 1.5 } },
      ],
    })
  })

  it("ignores unrecognized keys silently (forward-compat)", () => {
    expect(
      translateFilter({
        someFutureKey: "lol",
        status: "active",
      }),
    ).toEqual({
      must: [{ key: "metadata.corpus.status", match: { value: "active" } }],
    })
  })

  it("drops a null/undefined value rather than emitting an invalid clause", () => {
    expect(translateFilter({ status: undefined })).toBeUndefined()
    expect(translateFilter({ domain: null })).toBeUndefined()
  })
})
