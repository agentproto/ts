/**
 * Evidence-relationship helpers.
 *
 * Pure, ID-based lookups that derive Claim↔Source relationships from the
 * `sourceIds` / `claimIds` arrays already on those records. No rendering
 * framework, no fetching — callers (UI, CLI, tests) project these onto
 * whatever surface they need.
 */

import type { Claim, Source } from "./types.js"

/** Resolve the Source records cited by a Claim, in citation order. Silently drops dangling IDs — callers that need to detect those should use the source-quality gate instead. */
export function getSourcesForClaim(claim: Claim, sources: readonly Source[]): Source[] {
  const byId = new Map(sources.map((s) => [s.id, s] as const))
  return claim.sourceIds.map((id) => byId.get(id)).filter((s): s is Source => s !== undefined)
}

/** Resolve the Claim records that cite a given Source, in array order. */
export function getClaimsForSource(source: Source, claims: readonly Claim[]): Claim[] {
  return claims.filter((c) => c.sourceIds.includes(source.id))
}

/** A Claim with its cited Source records resolved, for rendering. */
export interface ClaimWithEvidence {
  claim: Claim
  sources: Source[]
}

/** Resolve every claim on a card against its sources, in claim order. */
export function resolveEvidence(
  claims: readonly Claim[],
  sources: readonly Source[],
): ClaimWithEvidence[] {
  return claims.map((claim) => ({ claim, sources: getSourcesForClaim(claim, sources) }))
}
