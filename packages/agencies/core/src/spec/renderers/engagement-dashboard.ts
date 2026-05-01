/**
 * Renderer wrapper for the `agency.engagement-dashboard` canvakit template.
 *
 * The template is a self-contained dashboard that re-reads workspace files on
 * every refresh tick. The host application substitutes `{{engagementSlug}}`
 * in the data-source paths before calling canvakit's resolver — variables
 * here are template-time values, NOT runtime data (which comes from the
 * declared data sources).
 */

import { z } from "zod"

export const ENGAGEMENT_DASHBOARD_TEMPLATE_ID =
  "agency.engagement-dashboard" as const

/** Path to the bundled .canvakit.html template (relative to the package root). */
export const ENGAGEMENT_DASHBOARD_TEMPLATE_PATH =
  "src/spec/canvakit-templates/agency.engagement-dashboard/template.canvakit.html" as const

export const engagementDashboardVariablesSchema = z.object({
  /** Slug of the engagement folder under `engagements/` (e.g. `2026-acme-website-redesign`). */
  engagementSlug: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "Expected lowercase slug (alphanumeric + hyphens)"
    ),
  /** Display name of the agency (header). */
  agencyName: z.string().min(1),
  /**
   * Base URL used when the dashboard renders signing links for pending
   * artifacts. The full link is `${signUrlBase}?artifactPath=...&nonce=...`.
   */
  signUrlBase: z.string().min(1).default("/sign"),
})
export type EngagementDashboardVariables = z.infer<
  typeof engagementDashboardVariablesSchema
>

export function engagementDashboardVariables(
  input: EngagementDashboardVariables
): Record<string, string> {
  return {
    engagementSlug: input.engagementSlug,
    agencyName: input.agencyName,
    signUrlBase: input.signUrlBase ?? "/sign",
  }
}
