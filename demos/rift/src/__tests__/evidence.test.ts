import { describe, expect, it } from "vitest"
import { getSourcesForClaim, getClaimsForSource, resolveEvidence } from "../evidence.js"
import { MOCK_CLAIMS, SOURCES } from "../mock-data.js"
import type { Claim, Source } from "../types.js"

describe("getSourcesForClaim", () => {
  it("resolves a claim's sources in citation order", () => {
    const claim = MOCK_CLAIMS.find((c) => c.id === "claim-agent-framework-star-parity-inference")
    expect(claim).toBeDefined()
    const resolved = getSourcesForClaim(claim!, SOURCES)
    expect(resolved.map((s) => s.id)).toEqual(["gh-langgraph-repo", "gh-crewai-repo", "gh-autogen-repo"])
  })

  it("silently drops dangling source IDs", () => {
    const claim: Claim = {
      id: "claim-dangling",
      text: "irrelevant",
      evidenceLabel: "Verified",
      sourceIds: ["does-not-exist"],
    }
    expect(getSourcesForClaim(claim, SOURCES)).toEqual([])
  })
})

describe("getClaimsForSource", () => {
  it("resolves every claim that cites a given source", () => {
    const source = SOURCES.find((s) => s.id === "gh-crewai-repo")
    expect(source).toBeDefined()
    const claims = getClaimsForSource(source!, MOCK_CLAIMS)
    expect(claims.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        "claim-crewai-stars",
        "claim-crewai-self-description-public",
        "claim-agent-framework-star-parity-inference",
      ]),
    )
  })

  it("returns an empty array for a source no claim cites", () => {
    const source: Source = { id: "orphan-source", type: "article", claimIds: [] }
    expect(getClaimsForSource(source, MOCK_CLAIMS)).toEqual([])
  })
})

describe("resolveEvidence", () => {
  it("pairs every claim with its resolved sources, in claim order", () => {
    const resolved = resolveEvidence(MOCK_CLAIMS, SOURCES)
    expect(resolved).toHaveLength(MOCK_CLAIMS.length)
    expect(resolved.map((r) => r.claim.id)).toEqual(MOCK_CLAIMS.map((c) => c.id))
    for (const { claim, sources } of resolved) {
      expect(sources.map((s) => s.id)).toEqual(claim.sourceIds.filter((id) => sources.some((s) => s.id === id)))
    }
  })
})
