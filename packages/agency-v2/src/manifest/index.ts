/**
 * AIP-21 AGENCY.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineAgencyV2` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-21/draft/AGENCY.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { agencyV2FrontmatterSchema, type AgencyV2Frontmatter } from "../schema.js"
import { defineAgencyV2 } from "../define-agency-v2.js"
import type { AgencyV2Definition, AgencyV2Handle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/agency-v2/manifest" or directly from "@@agentproto/agency-v2/schema".
export { agencyV2FrontmatterSchema, type AgencyV2Frontmatter }

export interface AgencyV2Manifest {
  frontmatter: AgencyV2Frontmatter
  body: string
}

export function parseAgencyV2Manifest(source: string): AgencyV2Manifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseAgencyV2Manifest: missing or empty frontmatter")
  }
  const result = agencyV2FrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseAgencyV2Manifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function agencyV2FromManifest(manifest: AgencyV2Manifest): AgencyV2Handle {
  // The zod-validated frontmatter is structurally compatible with
  // AgencyV2Definition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineAgencyV2(manifest.frontmatter as unknown as AgencyV2Definition)
}
