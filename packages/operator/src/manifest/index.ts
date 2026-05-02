/**
 * AIP-9 OPERATOR.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineOperator` so the cross-AIP
 * invariants run uniformly.
 *
 * TODO: tighten the frontmatter schema once the AIP-9 fields are
 * decided. The skeleton accepts arbitrary extra keys via `.loose()`.
 */

import matter from "gray-matter"
import { z } from "zod"
import { defineOperator } from "../define-operator.js"
import type { OperatorHandle } from "../types.js"

export const operatorManifestFrontmatterSchema = z
  .object({
    schema: z.literal("agentoperator/v1").optional(),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
    description: z.string().min(1).max(2000),
    // TODO: spec-9 fields.
  })
  .loose()

export type OperatorManifestFrontmatter = z.infer<
  typeof operatorManifestFrontmatterSchema
>

export interface OperatorManifest {
  frontmatter: OperatorManifestFrontmatter
  body: string
}

export function parseOperatorManifest(source: string): OperatorManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseOperatorManifest: missing or empty frontmatter")
  }
  const result = operatorManifestFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseOperatorManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function operatorFromManifest(manifest: OperatorManifest): OperatorHandle {
  const fm = manifest.frontmatter
  return defineOperator({
    id: fm.id,
    description: fm.description,
    // TODO: project the rest of the frontmatter.
  })
}
