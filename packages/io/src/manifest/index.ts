/**
 * AIP-16 IO.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineIo` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-16/draft/IO.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { ioFrontmatterSchema, type IoFrontmatter } from "../schema.js"
import { defineIo } from "../define-io.js"
import type { IoDefinition, IoHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/io/manifest" or directly from "@@agentproto/io/schema".
export { ioFrontmatterSchema, type IoFrontmatter }

export interface IoManifest {
  frontmatter: IoFrontmatter
  body: string
}

export function parseIoManifest(source: string): IoManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseIoManifest: missing or empty frontmatter")
  }
  const result = ioFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseIoManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function ioFromManifest(manifest: IoManifest): IoHandle {
  // The zod-validated frontmatter is structurally compatible with
  // IoDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineIo(manifest.frontmatter as unknown as IoDefinition)
}
