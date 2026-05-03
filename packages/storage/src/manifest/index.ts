/**
 * AIP-35 STORAGE.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineStorage` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-35/draft/STORAGE.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { storageFrontmatterSchema, type StorageFrontmatter } from "../schema.js"
import { defineStorage } from "../define-storage.js"
import type { StorageDefinition, StorageHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/storage/manifest" or directly from "@@agentproto/storage/schema".
export { storageFrontmatterSchema, type StorageFrontmatter }

export interface StorageManifest {
  frontmatter: StorageFrontmatter
  body: string
}

export function parseStorageManifest(source: string): StorageManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseStorageManifest: missing or empty frontmatter")
  }
  const result = storageFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseStorageManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function storageFromManifest(manifest: StorageManifest): StorageHandle {
  // The zod-validated frontmatter is structurally compatible with
  // StorageDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineStorage(manifest.frontmatter as unknown as StorageDefinition)
}
