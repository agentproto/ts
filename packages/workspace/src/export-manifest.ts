/**
 * AIP-34 EXPORT.md — the only file an ancestor of a `sealed`/`hard`
 * node may read from it. Mirrors `resources/aip-34/draft/EXPORT.schema.json`.
 * Frontmatter is a thin pointer (from, generated_at); the body is free
 * prose and is NEVER validated — that's the point of the format.
 */

import matter from "gray-matter"
import { z } from "zod"

export const exportManifestSchema = z
  .object({
    schema: z.literal("workspace-export/v1"),
    from: z.string().regex(/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/),
    generated_at: z.string().datetime({ offset: true }),
    generated_by: z.string().optional(),
    sections: z.array(z.string()).default([]),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .strict()

export type ExportManifestFrontmatter = z.infer<typeof exportManifestSchema>

export interface ExportManifest {
  frontmatter: ExportManifestFrontmatter
  body: string
}

export function parseExportManifest(source: string): ExportManifest {
  const parsed = matter(source)
  const result = exportManifestSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseExportManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function writeExportManifest(frontmatter: ExportManifestFrontmatter, body: string): string {
  const parsed = exportManifestSchema.parse(frontmatter)
  return matter.stringify(body, parsed)
}
