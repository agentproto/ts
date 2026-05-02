/**
 * AIP-26 CODE.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineCode` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-26/draft/CODE.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { codeFrontmatterSchema, type CodeFrontmatter } from "../schema.js"
import { defineCode } from "../define-code.js"
import type { CodeDefinition, CodeHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/code/manifest" or directly from "@@agentproto/code/schema".
export { codeFrontmatterSchema, type CodeFrontmatter }

export interface CodeManifest {
  frontmatter: CodeFrontmatter
  body: string
}

export function parseCodeManifest(source: string): CodeManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseCodeManifest: missing or empty frontmatter")
  }
  const result = codeFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseCodeManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function codeFromManifest(manifest: CodeManifest): CodeHandle {
  // The zod-validated frontmatter is structurally compatible with
  // CodeDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineCode(manifest.frontmatter as unknown as CodeDefinition)
}
