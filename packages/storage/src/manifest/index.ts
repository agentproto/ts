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
 * TODO: tighten the frontmatter schema once the AIP-35 fields are
 * decided. The skeleton accepts arbitrary extra keys via \`.loose()\`.
 */

import matter from "gray-matter"
import { z } from "zod"
import { defineStorage } from "../define-storage.js"
import type { StorageDefinition, StorageHandle } from "../types.js"

export const storageManifestFrontmatterSchema = z
  .object({
    schema: z.literal("agentstorage/v1").optional(),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
    description: z.string().min(1).max(2000),
    // TODO: spec-35 fields.
  })
  .loose()

export type StorageManifestFrontmatter = z.infer<
  typeof storageManifestFrontmatterSchema
>

export interface StorageManifest {
  frontmatter: StorageManifestFrontmatter
  body: string
}

export function parseStorageManifest(source: string): StorageManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseStorageManifest: missing or empty frontmatter")
  }
  const result = storageManifestFrontmatterSchema.safeParse(parsed.data)
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
