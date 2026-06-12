/**
 * Readers for the company `structure` block.
 *
 * `structure.positions` superseded `structure.roles` (the field always
 * held seat slugs in practice — see AIP-6 §structure.positions). Old
 * manifests on disk still carry `roles`, so reads go through
 * `companyPositions()` rather than touching either field directly.
 */

import type { CompanyDefinition } from "./types.js"

type CompanyStructure = Extract<
  CompanyDefinition,
  { doctype: "company" }
>["structure"]

/**
 * The company's seat slugs. Prefers `structure.positions`, falls back
 * to the deprecated `structure.roles` alias.
 */
export function companyPositions(
  company: { structure?: CompanyStructure } | undefined
): readonly string[] {
  const structure = company?.structure
  if (!structure) return []
  if (structure.positions && structure.positions.length > 0) {
    return structure.positions
  }
  return structure.roles ?? []
}
