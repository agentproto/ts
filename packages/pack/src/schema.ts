/**
 * AIP-52 PACK.md frontmatter zod schema.
 *
 * Imported by both `define-pack.ts` (TS path validation) and
 * `manifest/index.ts` (.md path validation) so every field-level
 * constraint runs in both authoring paths from a single source of truth.
 *
 * Cross-field rules (plugin must be resolvable, pricing.bundle > 0)
 * don't translate to a flat object schema and live in
 * `define-pack.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const packFrontmatterSchema = z.object({
  schema: z.literal("pack/v1"),
  name: z
    .string()
    .regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$"))
    .min(2)
    .max(80),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  version: z.string().min(1),
  plugin: z.object({
    inline: z.boolean().optional(),
    includes: z.array(z.string()).optional(),
  }),
  apps: z
    .array(
      z.object({
        id: z.string().min(1),
        path: z.string().min(1),
      }),
    )
    .optional(),
  knowledge: z
    .object({
      workspace: z.string().min(1),
      anyOf: z.array(z.string()).optional(),
      allOf: z.array(z.string()).optional(),
      kinds: z.array(z.string()).optional(),
    })
    .optional(),
  playbook: z
    .object({
      title: z.string().min(1),
      root: z.string().optional(),
      targetChapters: z.number().int().gte(1).optional(),
    })
    .optional(),
  pricing: z
    .object({
      ebook: z.number().gte(0).optional(),
      bundle: z.number().gte(0),
      step: z.number().gte(0).optional(),
    })
    .optional(),
  blockers: z.array(z.string()).optional(),
})

export type PackFrontmatter = z.infer<typeof packFrontmatterSchema>