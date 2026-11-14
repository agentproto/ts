/**
 * AIP-6 COMPANY.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineCompany` so the cross-AIP
 * invariants run uniformly.
 *
 * The aliases `kind` and `slug` are resolved before validation, so the
 * frontmatter handed back carries `doctype` and `id`. A legacy
 * `doctype: role` file is validated by `./legacy-role.ts`, not by the generated
 * schema (COMPANY.schema.json no longer defines it).
 */

import matter from "gray-matter"
import { canonicalizeCompany } from "../aliases.js"
import { defineCompany } from "../define-company.js"
import {
  legacyRoleFrontmatterSchema,
  type LegacyRoleFrontmatter,
} from "../legacy-role.js"
import { companyFrontmatterSchema, type CompanyFrontmatter } from "../schema.js"
import type { CompanyDefinition, CompanyHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@agentproto/company/manifest" or directly from "@agentproto/company/schema".
export {
  companyFrontmatterSchema,
  legacyRoleFrontmatterSchema,
  type CompanyFrontmatter,
  type LegacyRoleFrontmatter,
}

export interface CompanyManifest {
  frontmatter: CompanyFrontmatter | LegacyRoleFrontmatter
  body: string
}

export function parseCompanyManifest(source: string): CompanyManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseCompanyManifest: missing or empty frontmatter")
  }
  const data = canonicalizeCompany(parsed.data, "parseCompanyManifest")
  const result =
    data.doctype === "role"
      ? legacyRoleFrontmatterSchema.safeParse(data)
      : companyFrontmatterSchema.safeParse(data)
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
