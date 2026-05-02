/**
 * AIP-23 IDENTITY.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineIdentity` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-23/draft/IDENTITY.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { identityFrontmatterSchema, type IdentityFrontmatter } from "../schema.js"
import { defineIdentity } from "../define-identity.js"
import type { IdentityDefinition, IdentityHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/identity/manifest" or directly from "@@agentproto/identity/schema".
export { identityFrontmatterSchema, type IdentityFrontmatter }

export interface IdentityManifest {
  frontmatter: IdentityFrontmatter
  body: string
}

export function parseIdentityManifest(source: string): IdentityManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseIdentityManifest: missing or empty frontmatter")
  }
  const result = identityFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseIdentityManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function identityFromManifest(manifest: IdentityManifest): IdentityHandle {
  // The zod-validated frontmatter is structurally compatible with
  // IdentityDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineIdentity(manifest.frontmatter as unknown as IdentityDefinition)
}
