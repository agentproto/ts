/**
 * A `doctype: role` file under `schema: company/v1`: the pre-AIP-47 role form.
 * COMPANY.schema.json no longer validates it (AIP-6 §Backwards Compatibility),
 * so the shape a host still reads lives here, by hand, and is kept loose so a
 * file in the wild keeps loading.
 */

import { z } from "zod"

const SLUG = /^[a-z][a-z0-9-]*[a-z0-9]$/

export const legacyRoleFrontmatterSchema = z
  .object({
    schema: z.enum(["company/v1", "agentcompanies/v1"]),
    doctype: z.literal("role"),
    id: z.string().regex(SLUG).min(2).max(64),
    version: z.string().optional(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    mandate: z.string().min(1).max(2000),
    reports_to: z.string().regex(SLUG).optional(),
    scope: z
      .object({
        owns: z.array(z.string().max(200)).optional(),
        capabilities: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    objectives: z.array(z.string().regex(SLUG)).optional(),
    tools: z.array(z.string().regex(SLUG)).optional(),
    workflows: z.array(z.string().regex(SLUG)).optional(),
  })
  .loose()

export type LegacyRoleFrontmatter = z.infer<typeof legacyRoleFrontmatterSchema>
