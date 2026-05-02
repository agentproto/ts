/**
 * AIP-20 WORK.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineWork` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-20/draft/WORK.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { workFrontmatterSchema, type WorkFrontmatter } from "../schema.js"
import { defineWork } from "../define-work.js"
import type { WorkDefinition, WorkHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/work/manifest" or directly from "@@agentproto/work/schema".
export { workFrontmatterSchema, type WorkFrontmatter }

export interface WorkManifest {
  frontmatter: WorkFrontmatter
  body: string
}

export function parseWorkManifest(source: string): WorkManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseWorkManifest: missing or empty frontmatter")
  }
  const result = workFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseWorkManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function workFromManifest(manifest: WorkManifest): WorkHandle {
  // The zod-validated frontmatter is structurally compatible with
  // WorkDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineWork(manifest.frontmatter as unknown as WorkDefinition)
}
