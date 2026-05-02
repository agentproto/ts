/**
 * AIP-6 COMPANY.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineCompany` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-6/draft/COMPANY.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { companyFrontmatterSchema, type CompanyFrontmatter } from "../schema.js"
import { defineCompany } from "../define-company.js"
import type { CompanyDefinition, CompanyHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/company/manifest" or directly from "@@agentproto/company/schema".
export { companyFrontmatterSchema, type CompanyFrontmatter }

export interface CompanyManifest {
  frontmatter: CompanyFrontmatter
  body: string
}

export function parseCompanyManifest(source: string): CompanyManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseCompanyManifest: missing or empty frontmatter")
  }
  const result = companyFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseCompanyManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function companyFromManifest(manifest: CompanyManifest): CompanyHandle {
  // The zod-validated frontmatter is structurally compatible with
  // CompanyDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineCompany(manifest.frontmatter as unknown as CompanyDefinition)
}
