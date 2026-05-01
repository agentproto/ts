/**
 * Renderer wrapper for the `agency.agency-profile` canvakit template.
 *
 * Public-facing profile rendering of AGENCY.md. Reads AGENCY.md plus the
 * services/ and pricing-models/ directories, projects them into a marketing
 * page suitable as `/agency/<slug>` landing or a registry preview.
 *
 * No live tools — pure file + glob. Cacheable via `refreshEvery` set to a
 * long interval; defaults to none (host caches at CDN level).
 */

import { z } from "zod"

export const AGENCY_PROFILE_TEMPLATE_ID = "agency.agency-profile" as const

export const AGENCY_PROFILE_TEMPLATE_PATH =
  "src/spec/canvakit-templates/agency.agency-profile/template.canvakit.html" as const

export const agencyProfileVariablesSchema = z.object({
  /**
   * The primary header. Defaults to `agency.name` resolved from AGENCY.md
   * when omitted (template falls back to the data source).
   */
  agencyName: z.string().optional(),
  /** Optional one-line tagline shown under the H1. */
  agencyTagline: z.string().optional(),
  /** Optional public website URL shown in the footer. */
  websiteUrl: z.string().optional(),
  /** Where the "Start an engagement" CTA points. */
  contactUrl: z.string().default("/contact"),
  /** Override AGENCY.md.autonomyPosture in the "How we work" panel (rare). */
  autonomyPosture: z.string().optional(),
  /** Override AGENCY.md.defaultCurrency. */
  defaultCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("EUR"),
})
export type AgencyProfileVariables = z.infer<
  typeof agencyProfileVariablesSchema
>

export function agencyProfileVariables(
  input: AgencyProfileVariables
): Record<string, string> {
  return {
    agencyName: input.agencyName ?? "",
    agencyTagline: input.agencyTagline ?? "",
    websiteUrl: input.websiteUrl ?? "",
    contactUrl: input.contactUrl,
    autonomyPosture: input.autonomyPosture ?? "",
    defaultCurrency: input.defaultCurrency,
  }
}
