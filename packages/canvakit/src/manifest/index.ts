/**
 * AIP-5 TEMPLATE.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineCanvakit` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-5/draft/TEMPLATE.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { canvakitFrontmatterSchema, type CanvakitFrontmatter } from "../schema.js"
import { defineCanvakit } from "../define-canvakit.js"
import type { CanvakitDefinition, CanvakitHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/canvakit/manifest" or directly from "@@agentproto/canvakit/schema".
export { canvakitFrontmatterSchema, type CanvakitFrontmatter }

export interface CanvakitManifest {
  frontmatter: CanvakitFrontmatter
  body: string
}

export function parseCanvakitManifest(source: string): CanvakitManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseCanvakitManifest: missing or empty frontmatter")
  }
  const result = canvakitFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseCanvakitManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function canvakitFromManifest(manifest: CanvakitManifest): CanvakitHandle {
  // The zod-validated frontmatter is structurally compatible with
  // CanvakitDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineCanvakit(manifest.frontmatter as unknown as CanvakitDefinition)
}
