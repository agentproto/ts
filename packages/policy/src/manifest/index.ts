/**
 * AIP-38 POLICY.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `definePolicy` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-38/draft/POLICY.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { policyFrontmatterSchema, type PolicyFrontmatter } from "../schema.js"
import { definePolicy } from "../define-policy.js"
import type { PolicyDefinition, PolicyHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/policy/manifest" or directly from "@@agentproto/policy/schema".
export { policyFrontmatterSchema, type PolicyFrontmatter }

export interface PolicyManifest {
  frontmatter: PolicyFrontmatter
  body: string
}

export function parsePolicyManifest(source: string): PolicyManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parsePolicyManifest: missing or empty frontmatter")
  }
  const result = policyFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parsePolicyManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function policyFromManifest(manifest: PolicyManifest): PolicyHandle {
  // The zod-validated frontmatter is structurally compatible with
  // PolicyDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return definePolicy(manifest.frontmatter as unknown as PolicyDefinition)
}
