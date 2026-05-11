/**
 * AIP-47 ROLE.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineRole` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-47/draft/ROLE.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { roleFrontmatterSchema, type RoleFrontmatter } from "../schema.js"
import { defineRole } from "../define-role.js"
import type { RoleDefinition, RoleHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/role/manifest" or directly from "@@agentproto/role/schema".
export { roleFrontmatterSchema, type RoleFrontmatter }

export interface RoleManifest {
  frontmatter: RoleFrontmatter
  body: string
}

export function parseRoleManifest(source: string): RoleManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseRoleManifest: missing or empty frontmatter")
  }
  const result = roleFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseRoleManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function roleFromManifest(manifest: RoleManifest): RoleHandle {
  // The zod-validated frontmatter is structurally compatible with
  // RoleDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineRole(manifest.frontmatter as unknown as RoleDefinition)
}
