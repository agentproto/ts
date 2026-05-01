import { z } from "zod"
import {
  countryIsoSchema,
  currencyIsoSchema,
  envelope,
  isoDateOrDateSchema,
  kebabSlugSchema,
  timezoneSchema,
} from "./_common.js"

/**
 * agentagencies/v1 — `AGENCY.md` doctype.
 *
 * Operational profile of the company when it acts as an agency.
 * Lives at `<workspace-root>/AGENCY.md` alongside (NOT replacing) `COMPANY.md`
 * from agentcompanies/v1. Optional — a workspace is a valid agentagencies
 * package without it as long as the other doctypes are reachable via
 * `COMPANY.md.includes[]` or filesystem convention.
 *
 * Carries operational defaults that would otherwise be sprinkled across
 * services / pricing / policies (verticals, default currency, autonomy posture).
 */

export const AUTONOMY_POSTURE = ["full-auto", "hybrid", "manual"] as const
export const autonomyPostureSchema = z.enum(AUTONOMY_POSTURE)
export type AutonomyPosture = z.infer<typeof autonomyPostureSchema>

export const agencyFrontmatterSchema = z.object({
  ...envelope("agency"),

  /** Vertical templates this agency uses (slugs from agencies.sh registry, e.g., "design-project"). */
  verticals: z.array(kebabSlugSchema).default([]),

  /** Slugs of the primary services this agency offers (refs to services/<slug>/SERVICE.md). */
  primaryServices: z.array(kebabSlugSchema).default([]),

  /** Default pricing-model slug applied when a service doesn't specify one. */
  defaultPricingModel: kebabSlugSchema.optional(),

  defaultCurrency: currencyIsoSchema.optional(),
  defaultCountry: countryIsoSchema.optional(),
  billingTimezone: timezoneSchema.optional(),

  /** ISO date marking the start of the fiscal year (e.g., 2026-01-01). */
  fiscalYearStart: isoDateOrDateSchema.optional(),

  autonomyPosture: autonomyPostureSchema.default("hybrid"),

  /** External package paths this AGENCY.md pulls in. Mirrors COMPANY.md.includes[]. */
  includes: z.array(z.string()).default([]),
})
export type AgencyFrontmatter = z.infer<typeof agencyFrontmatterSchema>

export interface Agency {
  frontmatter: AgencyFrontmatter
  body: string
}

export const AGENCY_FILENAME = "AGENCY.md" as const
