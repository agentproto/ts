import { describe, expect, it } from "vitest"
import { checkSourceQuality } from "../source-quality.js"
import { MOCK_CARD, MOCK_CLAIMS, SOURCES } from "../mock-data.js"
import type { Claim, Source } from "../types.js"

const verifiedSource: Source = {
  id: "s-verified",
  type: "article",
  url: "https://example.com/a",
  title: "A Title",
  observedAt: "2026-07-27T00:00:00.000Z",
  excerpt: "A sufficiently long verbatim excerpt from the source document.",
  claimIds: ["c-verified"],
  quality: { tier: "primary", score: 0.8 },
}

describe("checkSourceQuality — real fixtures pass", () => {
  it("finds no issues in the real MOCK_CLAIMS/SOURCES fixtures", () => {
    const issues = checkSourceQuality({ claims: MOCK_CLAIMS, sources: SOURCES })
    expect(issues).toEqual([])
  })

  it("finds no issues in MOCK_CARD including its recommendation rationale", () => {
    const issues = checkSourceQuality({
      claims: MOCK_CARD.claims,
      sources: MOCK_CARD.sources,
      recommendation: MOCK_CARD.recommendation,
    })
    expect(issues).toEqual([])
  })
})

describe("checkSourceQuality — invented-citation", () => {
  it("rejects a claim citing a source ID that does not exist", () => {
    const claim: Claim = { id: "c1", text: "x", evidenceLabel: "Verified", sourceIds: ["ghost"] }
    const issues = checkSourceQuality({ claims: [claim], sources: [] })
    expect(issues).toEqual([
      expect.objectContaining({ code: "invented-citation", claimId: "c1", sourceId: "ghost" }),
    ])
  })
})

describe("checkSourceQuality — missing-provenance (Verified)", () => {
  it("rejects a Verified claim whose source lacks url/title/date/excerpt/type/quality", () => {
    const source: Source = { id: "s1", type: "", claimIds: [] }
    const claim: Claim = { id: "c1", text: "x", evidenceLabel: "Verified", sourceIds: ["s1"] }
    const issues = checkSourceQuality({ claims: [claim], sources: [source] })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ code: "missing-provenance", claimId: "c1", sourceId: "s1" })
    expect(issues[0]!.message).toContain("url")
    expect(issues[0]!.message).toContain("bounded excerpt")
  })

  it("rejects a Verified claim whose excerpt is out of bounds", () => {
    const tooShort: Source = { ...verifiedSource, id: "s-short", excerpt: "short" }
    const claim: Claim = { id: "c1", text: "x", evidenceLabel: "Verified", sourceIds: ["s-short"] }
    const issues = checkSourceQuality({ claims: [claim], sources: [tooShort] })
    expect(issues).toEqual([expect.objectContaining({ code: "missing-provenance" })])
  })
})

describe("checkSourceQuality — missing-provenance (Public claim)", () => {
  it("rejects a Public claim whose source has neither url nor title", () => {
    const source: Source = { id: "s1", type: "social-post", claimIds: [] }
    const claim: Claim = { id: "c1", text: "x", evidenceLabel: "Public claim", sourceIds: ["s1"] }
    const issues = checkSourceQuality({ claims: [claim], sources: [source] })
    expect(issues).toEqual([expect.objectContaining({ code: "missing-provenance", claimId: "c1" })])
  })

  it("accepts a Public claim source with only a title and a type", () => {
    const source: Source = { id: "s1", type: "social-post", title: "Some Vendor", claimIds: [] }
    const claim: Claim = { id: "c1", text: "x", evidenceLabel: "Public claim", sourceIds: ["s1"] }
    expect(checkSourceQuality({ claims: [claim], sources: [source] })).toEqual([])
  })
})

describe("checkSourceQuality — insufficient-inference-sources", () => {
  it("rejects an Inference with fewer than 2 distinct source IDs", () => {
    const claim: Claim = {
      id: "c1",
      text: "x",
      evidenceLabel: "Inference",
      sourceIds: ["s-verified"],
      uncertainty: "some uncertainty",
    }
    const issues = checkSourceQuality({ claims: [claim], sources: [verifiedSource] })
    expect(issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "insufficient-inference-sources", claimId: "c1" })]),
    )
  })

  it("rejects an Inference missing an uncertainty note", () => {
    const s2: Source = { ...verifiedSource, id: "s-verified-2" }
    const claim: Claim = {
      id: "c1",
      text: "x",
      evidenceLabel: "Inference",
      sourceIds: ["s-verified", "s-verified-2"],
    }
    const issues = checkSourceQuality({ claims: [claim], sources: [verifiedSource, s2] })
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-provenance", message: expect.stringContaining("uncertainty note") }),
      ]),
    )
  })
})

describe("checkSourceQuality — duplicate-corroboration", () => {
  it("rejects an Inference whose two sourceIds resolve to the same URL", () => {
    const dup: Source = { ...verifiedSource, id: "s-verified-dup" }
    const claim: Claim = {
      id: "c1",
      text: "x",
      evidenceLabel: "Inference",
      sourceIds: ["s-verified", "s-verified-dup"],
      uncertainty: "some uncertainty",
    }
    const issues = checkSourceQuality({ claims: [claim], sources: [verifiedSource, dup] })
    expect(issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "duplicate-corroboration", claimId: "c1" })]),
    )
  })
})

describe("checkSourceQuality — unsupported-rationale", () => {
  it("rejects a recommendation rationale citing no claim IDs", () => {
    const issues = checkSourceQuality({
      claims: [],
      sources: [],
      recommendation: { recommendation: "wait", reasons: ["because"] },
    })
    expect(issues).toEqual([expect.objectContaining({ code: "unsupported-rationale" })])
  })

  it("rejects a recommendation rationale citing a claim ID that does not exist", () => {
    const issues = checkSourceQuality({
      claims: [],
      sources: [],
      recommendation: { recommendation: "wait", reasons: ["because"], claimIds: ["ghost-claim"] },
    })
    expect(issues).toEqual([expect.objectContaining({ code: "unsupported-rationale", claimId: "ghost-claim" })])
  })

  it("accepts a recommendation rationale citing a real claim ID", () => {
    const claim: Claim = { id: "c1", text: "x", evidenceLabel: "Verified", sourceIds: [] }
    const issues = checkSourceQuality({
      claims: [claim],
      sources: [],
      recommendation: { recommendation: "wait", reasons: ["because"], claimIds: ["c1"] },
    })
    expect(issues).toEqual([])
  })
})
