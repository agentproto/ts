/**
 * AIP-4 DESIGN.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineDesign` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-4/draft/DESIGN.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { designFrontmatterSchema, type DesignFrontmatter } from "../schema.js"
import { defineDesign } from "../define-design.js"
import type { DesignDefinition, DesignHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/design/manifest" or directly from "@@agentproto/design/schema".
export { designFrontmatterSchema, type DesignFrontmatter }

export interface DesignManifest {
  frontmatter: DesignFrontmatter
  body: string
}

export function parseDesignManifest(source: string): DesignManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseDesignManifest: missing or empty frontmatter")
  }
  const result = designFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseDesignManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function designFromManifest(manifest: DesignManifest): DesignHandle {
  // The zod-validated frontmatter is structurally compatible with
  // DesignDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineDesign(manifest.frontmatter as unknown as DesignDefinition)
}
