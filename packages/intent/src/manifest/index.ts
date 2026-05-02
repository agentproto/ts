/**
 * AIP-28 INTENT.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineIntent` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-28/draft/INTENT.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { intentFrontmatterSchema, type IntentFrontmatter } from "../schema.js"
import { defineIntent } from "../define-intent.js"
import type { IntentDefinition, IntentHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/intent/manifest" or directly from "@@agentproto/intent/schema".
export { intentFrontmatterSchema, type IntentFrontmatter }

export interface IntentManifest {
  frontmatter: IntentFrontmatter
  body: string
}

export function parseIntentManifest(source: string): IntentManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseIntentManifest: missing or empty frontmatter")
  }
  const result = intentFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseIntentManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function intentFromManifest(manifest: IntentManifest): IntentHandle {
  // The zod-validated frontmatter is structurally compatible with
  // IntentDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineIntent(manifest.frontmatter as unknown as IntentDefinition)
}
