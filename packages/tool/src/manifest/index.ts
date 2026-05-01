import matter from "gray-matter"
import { z } from "zod"

/**
 * AIP-14 TOOL.md sidecar parser.
 *
 * Reads frontmatter (host-relevant metadata) + body (long-form
 * description / examples / errors). The TS module's `defineTool(...)`
 * supplies the schemas and execute body; this manifest supplies the
 * runtime metadata that overrides or augments the in-code defaults.
 *
 * Field set covers AIP-14 §"Frontmatter" — required and optional fields
 * normalised to snake_case → camelCase.
 */

export const toolManifestFrontmatterSchema = z.object({
  schema: z.literal("agentproto/tool/v1").optional(),
  name: z.string().min(1).max(80),
  id: z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/),
  description: z.string().min(1).max(2000),
  version: z.string().regex(/^\d+\.\d+\.\d+/),

  // Optional metadata
  mutates: z.array(z.string()).optional(),
  requires: z
    .object({
      network: z.array(z.string()).optional(),
      secrets: z.array(z.string()).optional(),
      tools: z.array(z.string()).optional(),
    })
    .optional(),
  approval: z
    .union([
      z.literal("auto"),
      z.literal("always"),
      z.literal("on-mutate"),
      z.string().regex(/^policy:/),
    ])
    .optional(),
  risk_level: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
    .optional(),
  cost_class: z.enum(["trivial", "metered", "expensive"]).optional(),
  timeout_ms: z.number().int().positive().optional(),
  idempotent: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),

  // AIP-26 / AIP-17 / AIP-19 references — kept loose; validated by their
  // respective AIPs' adapters when consumed.
  code: z.unknown().optional(),
  run: z.unknown().optional(),
  runner: z.unknown().optional(),
  secrets: z.unknown().optional(),
  network: z.unknown().optional(),
})

export type ToolManifestFrontmatter = z.infer<
  typeof toolManifestFrontmatterSchema
>

export interface ToolManifest {
  frontmatter: ToolManifestFrontmatter
  body: string
}

/**
 * Parse a TOOL.md source string into structured frontmatter + body.
 * Throws on missing frontmatter or schema-invalid frontmatter.
 */
export function parseToolManifest(source: string): ToolManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseToolManifest: missing or empty frontmatter")
  }
  const result = toolManifestFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseToolManifest: invalid frontmatter — ${result.error.issues
        .map(i => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}
