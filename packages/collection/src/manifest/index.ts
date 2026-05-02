/**
 * AIP-18 COLLECTION.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineCollection` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-18/draft/COLLECTION.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { collectionFrontmatterSchema, type CollectionFrontmatter } from "../schema.js"
import { defineCollection } from "../define-collection.js"
import type { CollectionDefinition, CollectionHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/collection/manifest" or directly from "@@agentproto/collection/schema".
export { collectionFrontmatterSchema, type CollectionFrontmatter }

export interface CollectionManifest {
  frontmatter: CollectionFrontmatter
  body: string
}

export function parseCollectionManifest(source: string): CollectionManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseCollectionManifest: missing or empty frontmatter")
  }
  const result = collectionFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseCollectionManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function collectionFromManifest(manifest: CollectionManifest): CollectionHandle {
  // The zod-validated frontmatter is structurally compatible with
  // CollectionDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineCollection(manifest.frontmatter as unknown as CollectionDefinition)
}
