/**
 * Source-quality gate.
 *
 * Pure, deterministic validation of Claim/Source provenance against the
 * Evidence contract:
 *   - Verified   → url, title, a publication/observation date, a bounded
 *                  excerpt, a source type, and quality metadata.
 *   - Public claim → attributed source (title or url) with a type; treated
 *                  as an attributed statement, never outcome proof.
 *   - Inference  → ≥ 2 distinct, individually-provenanced sources and a
 *                  non-empty uncertainty note.
 *
 * No network, no randomness — every function here takes plain data and
 * returns plain data.
 */

import type { Claim, RecommendationRationale, Source } from "./types.js"

export type SourceQualityIssueCode =
  | "missing-provenance"
  | "duplicate-corroboration"
  | "unsupported-rationale"
  | "invented-citation"
  | "insufficient-inference-sources"

export interface SourceQualityIssue {
  code: SourceQualityIssueCode
  message: string
  claimId?: string
  sourceId?: string
}

const EXCERPT_MIN_LENGTH = 10
const EXCERPT_MAX_LENGTH = 500

function hasBoundedExcerpt(source: Source): boolean {
  if (!source.excerpt) return false
  return source.excerpt.length > EXCERPT_MIN_LENGTH && source.excerpt.length <= EXCERPT_MAX_LENGTH
}

function hasDate(source: Source): boolean {
  return Boolean(source.publishedAt || source.observedAt)
}

function hasQualityMetadata(source: Source): boolean {
  return Boolean(source.quality && (source.quality.score !== undefined || source.quality.tier !== undefined))
}

/** Provenance required for a source cited as "Verified" evidence. */
function verifiedProvenanceIssues(claim: Claim, source: Source): SourceQualityIssue[] {
  const issues: SourceQualityIssue[] = []
  const missing: string[] = []
  if (!source.url) missing.push("url")
  if (!source.title) missing.push("title")
  if (!hasDate(source)) missing.push("publishedAt/observedAt")
  if (!hasBoundedExcerpt(source)) missing.push("bounded excerpt")
  if (!source.type) missing.push("type")
  if (!hasQualityMetadata(source)) missing.push("quality metadata")
  if (missing.length > 0) {
    issues.push({
      code: "missing-provenance",
      message: `Verified claim "${claim.id}" cites source "${source.id}" missing: ${missing.join(", ")}`,
      claimId: claim.id,
      sourceId: source.id,
    })
  }
  return issues
}

/** Provenance required for a source cited as "Public claim" — attribution, not proof. */
function publicClaimProvenanceIssues(claim: Claim, source: Source): SourceQualityIssue[] {
  const missing: string[] = []
  if (!source.url && !source.title) missing.push("url or title (attribution)")
  if (!source.type) missing.push("type")
  if (missing.length === 0) return []
  return [
    {
      code: "missing-provenance",
      message: `Public-claim "${claim.id}" cites source "${source.id}" missing: ${missing.join(", ")}`,
      claimId: claim.id,
      sourceId: source.id,
    },
  ]
}

/** Per-source provenance required for a source cited as part of an Inference. */
function inferenceSourceProvenanceIssues(claim: Claim, source: Source): SourceQualityIssue[] {
  const missing: string[] = []
  if (!source.url && !source.title) missing.push("url or title")
  if (!source.type) missing.push("type")
  if (missing.length === 0) return []
  return [
    {
      code: "missing-provenance",
      message: `Inference "${claim.id}" cites source "${source.id}" missing: ${missing.join(", ")}`,
      claimId: claim.id,
      sourceId: source.id,
    },
  ]
}

function checkClaim(claim: Claim, sourcesById: ReadonlyMap<string, Source>): SourceQualityIssue[] {
  const issues: SourceQualityIssue[] = []

  const resolved: Source[] = []
  for (const sourceId of claim.sourceIds) {
    const source = sourcesById.get(sourceId)
    if (!source) {
      issues.push({
        code: "invented-citation",
        message: `Claim "${claim.id}" cites source ID "${sourceId}" which does not exist`,
        claimId: claim.id,
        sourceId,
      })
      continue
    }
    resolved.push(source)
  }

  if (claim.evidenceLabel === "Verified") {
    for (const source of resolved) issues.push(...verifiedProvenanceIssues(claim, source))
  } else if (claim.evidenceLabel === "Public claim") {
    for (const source of resolved) issues.push(...publicClaimProvenanceIssues(claim, source))
  } else {
    // Inference
    const distinctIds = new Set(claim.sourceIds)
    if (distinctIds.size < 2) {
      issues.push({
        code: "insufficient-inference-sources",
        message: `Inference "${claim.id}" cites ${distinctIds.size} distinct source ID(s); at least 2 are required`,
        claimId: claim.id,
      })
    }
    if (!claim.uncertainty || claim.uncertainty.trim().length === 0) {
      issues.push({
        code: "missing-provenance",
        message: `Inference "${claim.id}" is missing an uncertainty note`,
        claimId: claim.id,
      })
    }
    for (const source of resolved) issues.push(...inferenceSourceProvenanceIssues(claim, source))

    const seenUrls = new Map<string, string>()
    for (const source of resolved) {
      if (!source.url) continue
      const priorSourceId = seenUrls.get(source.url)
      if (priorSourceId && priorSourceId !== source.id) {
        issues.push({
          code: "duplicate-corroboration",
          message: `Inference "${claim.id}" cites sources "${priorSourceId}" and "${source.id}" which share the same URL and cannot corroborate each other`,
          claimId: claim.id,
          sourceId: source.id,
        })
      }
      seenUrls.set(source.url, source.id)
    }
  }

  return issues
}

function checkRecommendationRationale(
  rationale: RecommendationRationale,
  claimsById: ReadonlyMap<string, Claim>,
): SourceQualityIssue[] {
  const claimIds = rationale.claimIds ?? []
  if (claimIds.length === 0) {
    return [
      {
        code: "unsupported-rationale",
        message: `Recommendation "${rationale.recommendation}" cites no claim IDs`,
      },
    ]
  }
  const issues: SourceQualityIssue[] = []
  for (const claimId of claimIds) {
    if (!claimsById.has(claimId)) {
      issues.push({
        code: "unsupported-rationale",
        message: `Recommendation "${rationale.recommendation}" cites claim ID "${claimId}" which does not exist`,
        claimId,
      })
    }
  }
  return issues
}

/**
 * Run the full source-quality gate over a card's claims/sources and
 * (optionally) its recommendation rationale. Returns every issue found;
 * an empty array means the card passes the gate.
 */
export function checkSourceQuality(input: {
  claims: readonly Claim[]
  sources: readonly Source[]
  recommendation?: RecommendationRationale
}): SourceQualityIssue[] {
  const sourcesById = new Map(input.sources.map((s) => [s.id, s] as const))
  const claimsById = new Map(input.claims.map((c) => [c.id, c] as const))

  const issues: SourceQualityIssue[] = []
  for (const claim of input.claims) issues.push(...checkClaim(claim, sourcesById))
  if (input.recommendation) issues.push(...checkRecommendationRationale(input.recommendation, claimsById))
  return issues
}
