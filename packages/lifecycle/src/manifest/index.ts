/**
 * AIP-37 LIFECYCLE.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineLifecycle` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * TODO: tighten the frontmatter schema once the AIP-37 fields are
 * decided. The skeleton accepts arbitrary extra keys via \`.loose()\`.
 */

import matter from "gray-matter"
import { z } from "zod"
import { defineLifecycle } from "../define-lifecycle.js"
import type { LifecycleDefinition, LifecycleHandle } from "../types.js"

export const lifecycleManifestFrontmatterSchema = z
  .object({
    schema: z.literal("agentlifecycle/v1").optional(),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
    description: z.string().min(1).max(2000),
    // TODO: spec-37 fields.
  })
  .loose()

export type LifecycleManifestFrontmatter = z.infer<
  typeof lifecycleManifestFrontmatterSchema
>

export interface LifecycleManifest {
  frontmatter: LifecycleManifestFrontmatter
  body: string
}

export function parseLifecycleManifest(source: string): LifecycleManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseLifecycleManifest: missing or empty frontmatter")
  }
  const result = lifecycleManifestFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseLifecycleManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function lifecycleFromManifest(manifest: LifecycleManifest): LifecycleHandle {
  // The zod-validated frontmatter is structurally compatible with
  // LifecycleDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineLifecycle(manifest.frontmatter as unknown as LifecycleDefinition)
}
