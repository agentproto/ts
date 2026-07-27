/**
 * Baseline tests — typed mock-data contract.
 *
 * Validates structural integrity of types, evidence-label semantics,
 * and mock-data invariants.
 */

import { describe, it, expect } from "vitest"
import {
  SOURCES,
  MOCK_INPUT,
  MOCK_CLAIMS,
  MOCK_CARD,
  MOCK_CARDS,
} from "../mock-data.js"
import type {
  RiftInput,
  RiftCard,
  Claim,
  Source,
  EvidenceLabel,
  SourceQuality,
  RiftAppState,
  CardStatus,
  Recommendation,
  GeneratedDrafts,
} from "../types.js"

// ─── Source contract ────────────────────────────────────────────────

describe("Source contract", () => {
  it("every source has a non-empty id and type", () => {
    for (const src of SOURCES) {
      expect(src.id.length).toBeGreaterThan(0)
      expect(src.type.length).toBeGreaterThan(0)
    }
  })

  it("every source has claimIds array", () => {
    for (const src of SOURCES) {
      expect(Array.isArray(src.claimIds)).toBe(true)
    }
  })

  it("source ids are unique", () => {
    const ids = SOURCES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("sources with publishedAt use ISO-8601 format", () => {
    for (const src of SOURCES) {
      if (src.publishedAt) {
        expect(src.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}/)
      }
    }
  })

  it("sources with observedAt use ISO-8601 format", () => {
    for (const src of SOURCES) {
      if (src.observedAt) {
        expect(src.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}/)
      }
    }
  })

  it("sources with an excerpt have bounded text", () => {
    for (const src of SOURCES) {
      if (src.excerpt) {
        expect(src.excerpt.length).toBeGreaterThan(10)
        expect(src.excerpt.length).toBeLessThanOrEqual(500)
      }
    }
  })

  it("quality slot is optional SourceQuality when present", () => {
    for (const src of SOURCES) {
      if (src.quality) {
        const q: SourceQuality = src.quality
        expect(q).toBeDefined()
      }
    }
  })
})

// ─── Claim contract ─────────────────────────────────────────────────

describe("Claim contract", () => {
  it("every claim has a non-empty id", () => {
    for (const claim of MOCK_CLAIMS) {
      expect(claim.id.length).toBeGreaterThan(0)
    }
  })

  it("claim ids are unique", () => {
    const ids = MOCK_CLAIMS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("every claim has non-empty text", () => {
    for (const claim of MOCK_CLAIMS) {
      expect(claim.text.length).toBeGreaterThan(0)
    }
  })
})

// ─── Evidence-label semantics ───────────────────────────────────────

describe("Evidence-label semantics", () => {
  const validLabels: EvidenceLabel[] = ["Verified", "Public claim", "Inference"]

  it("every claim uses a valid EvidenceLabel", () => {
    for (const claim of MOCK_CLAIMS) {
      expect(validLabels).toContain(claim.evidenceLabel)
    }
  })

  it("every claim references at least one source ID", () => {
    for (const claim of MOCK_CLAIMS) {
      expect(claim.sourceIds.length).toBeGreaterThanOrEqual(1)
    }
  })

  it("inference claims reference ≥ 2 distinct source IDs", () => {
    for (const claim of MOCK_CLAIMS) {
      if (claim.evidenceLabel === "Inference") {
        expect(new Set(claim.sourceIds).size).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it("inference claims carry an uncertainty note", () => {
    for (const claim of MOCK_CLAIMS) {
      if (claim.evidenceLabel === "Inference") {
        expect(typeof claim.uncertainty).toBe("string")
        expect(claim.uncertainty!.length).toBeGreaterThan(0)
      }
    }
  })
})

// ─── Mock-input contract ────────────────────────────────────────────

describe("Mock input", () => {
  it("has non-empty rawText", () => {
    expect(MOCK_INPUT.rawText.trim().length).toBeGreaterThan(0)
  })

  it("type-checks as RiftInput", () => {
    const input: RiftInput = MOCK_INPUT
    expect(input.rawText).toBe(MOCK_INPUT.rawText)
  })
})

// ─── Mock-card contract ─────────────────────────────────────────────

describe("Mock card", () => {
  it("has a non-empty id", () => {
    expect(MOCK_CARD.id.length).toBeGreaterThan(0)
  })

  it("card input matches MOCK_INPUT", () => {
    expect(MOCK_CARD.input).toBe(MOCK_INPUT)
  })

  it("card claims are an array (may be empty for placeholder)", () => {
    expect(Array.isArray(MOCK_CARD.claims)).toBe(true)
  })

  it("card sources are an array (may be empty for placeholder)", () => {
    expect(Array.isArray(MOCK_CARD.sources)).toBe(true)
  })

  it("createdAt and updatedAt are ISO-8601 strings", () => {
    expect(MOCK_CARD.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(MOCK_CARD.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("recommendation is a valid Recommendation type", () => {
    const validRecs: Recommendation[] = ["build", "wait", "reject"]
    expect(validRecs).toContain(MOCK_CARD.recommendation?.recommendation)
  })

  it("drafts are placeholder objects", () => {
    expect(MOCK_CARD.drafts?.prd.placeholder).toBe(true)
    expect(MOCK_CARD.drafts?.landingPage.placeholder).toBe(true)
    expect(MOCK_CARD.drafts?.xPost.placeholder).toBe(true)
  })
})

// ─── MOCK_CARDS array ───────────────────────────────────────────────

describe("MOCK_CARDS", () => {
  it("is a non-empty array", () => {
    expect(MOCK_CARDS.length).toBeGreaterThan(0)
  })

  it("every entry is structurally valid (has id, input, claims, sources)", () => {
    for (const card of MOCK_CARDS) {
      expect(card.id.length).toBeGreaterThan(0)
      expect(card.input).toBeDefined()
      expect(Array.isArray(card.claims)).toBe(true)
      expect(Array.isArray(card.sources)).toBe(true)
    }
  })
})

// ─── Type-level smoke (compile-time) ────────────────────────────────

describe("Type assignments (compile-time smoke)", () => {
  it("all evidence labels compile", () => {
    const labels: EvidenceLabel[] = ["Verified", "Public claim", "Inference"]
    expect(labels.length).toBe(3)
  })

  it("card status values compile", () => {
    const statuses: CardStatus[] = ["loading", "ready", "error"]
    expect(statuses.length).toBe(3)
  })

  it("recommendation values compile", () => {
    const recs: Recommendation[] = ["build", "wait", "reject"]
    expect(recs.length).toBe(3)
  })

  it("SourceQuality compiles", () => {
    const q: SourceQuality = { score: 0.8, tier: "primary" }
    expect(q.score).toBe(0.8)
  })
})
