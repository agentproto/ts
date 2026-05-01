import { z } from "zod"
import { envelope, isoDurationSchema, kebabSlugSchema } from "./_common.js"

/**
 * agentagencies/v1 — `SERVICE.md` doctype.
 *
 * Catalog item — what the agency sells. Composes one or more SKILL.md
 * (companies.sh) refs + a default PROCEDURE.md (the playbook to execute when
 * this service is requested) + a default pricing model + scope template.
 */

export const serviceFrontmatterSchema = z.object({
  ...envelope("service"),

  /**
   * Skills required to deliver this service. Refs to companies.sh skills
   * (`SKILL.md` shortnames or paths); resolution per skills.sh / companies.sh rules.
   */
  requiredSkills: z.array(z.string()).default([]),

  /** Default procedure slug to execute when this service is invoked. */
  defaultProcedure: kebabSlugSchema.optional(),

  /** Default pricing-model slug. */
  defaultPricingModel: kebabSlugSchema.optional(),

  /** Estimated duration as ISO-8601 duration (e.g., PT2H, P5D). */
  estimatedDuration: isoDurationSchema.optional(),

  /** Free-form prerequisites for the counterparty (info needed before scoping). */
  prerequisites: z.array(z.string()).default([]),

  /**
   * Scope template — the structure of the engagement scope when this service
   * is sold. Free-form for v1; templates may add their own conventions.
   */
  scopeTemplate: z.unknown().optional(),

  /** Tags for catalog discovery (e.g., ["plumbing", "emergency"]). */
  tags: z.array(z.string()).default([]),

  /** External listing flag — show on agencies.sh registry / public pages. */
  publishable: z.boolean().default(true),
})
export type ServiceFrontmatter = z.infer<typeof serviceFrontmatterSchema>

export interface Service {
  frontmatter: ServiceFrontmatter
  body: string
}

export const SERVICE_FILENAME = "SERVICE.md" as const
