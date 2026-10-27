/**
 * AIP-34 EXPORT.md — the only file an ancestor of a `sealed`/`hard`
 * node may read from it. Mirrors `specs/resources/aip-34/draft/EXPORT.schema.json`
 * in agentproto/agentproto (agentproto/agentproto#69, not yet merged — not
 * vendored into this repo's own `specs/resources/` yet).
 * Frontmatter is a thin pointer (from, generated_at); the body is free
 * prose and is NEVER validated — that's the point of the format.
 */

import matter from "gray-matter"
import { z } from "zod"

export const exportManifestSchema = z
  .object({
    schema: z.enum(["workspace.export/v1", "workspace-export/v1"]),
    from: z.string().regex(/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/),
    generated_at: z.string().datetime({ offset: true }),
    generated_by: z.string().optional(),
    sections: z.array(z.string()).default([]),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .strict()

export type ExportManifestFrontmatter = z.infer<typeof exportManifestSchema>
export type ExportManifestFrontmatterInput = z.input<typeof exportManifestSchema>

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

export function writeExportManifest(frontmatter: ExportManifestFrontmatterInput, body: string): string {
  const parsed = exportManifestSchema.parse(frontmatter)
  // Writers emit the canonical tag; readers still accept the legacy
  // workspace-export/v1 alias in the schema enum above.
  return matter.stringify(body, { ...parsed, schema: "workspace.export/v1" })
}
