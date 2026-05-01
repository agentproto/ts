/**
 * Renderer wrapper for the `agency.agency-overview` canvakit template.
 *
 * The overview is a routine-populated rollup. The template's only data
 * source is `_snapshots/agency-overview.json`, written by a procedure that
 * walks the workspace and computes aggregates. The shape of that snapshot
 * is documented here as `AgencyOverviewSnapshot` so writers + readers
 * stay in sync.
 *
 * Why a snapshot rather than live globs:
 *   - Counting + summing 50 engagements on every page-view is expensive.
 *   - Per-engagement parsing of frontmatter is the bottleneck (no DB index).
 *   - Snapshots invert the cost: compute once per cron tick, render cheap.
 *
 * Trade-off: the dashboard shows up-to-`refreshEvery` stale data. The
 * snapshot's `generatedAt` field plus the staleness banner make that
 * visible to the operator.
 */

import { z } from "zod"

export const AGENCY_OVERVIEW_TEMPLATE_ID = "agency.agency-overview" as const

export const AGENCY_OVERVIEW_TEMPLATE_PATH =
  "src/spec/canvakit-templates/agency.agency-overview/template.canvakit.html" as const

/** Snapshot shape — the procedure writes `_snapshots/agency-overview.json` matching this. */
export const agencyOverviewSnapshotSchema = z.object({
  /** ISO 8601 timestamp of when the snapshot was computed. */
  generatedAt: z.string().min(1),
  /** Set true when `Date.now() - generatedAt` exceeds the freshness threshold (default 30 min). */
  isStale: z.boolean().default(false),

  activeEngagementsCount: z.number().int().nonnegative(),
  activeEngagementsDelta: z.number().int().default(0),
  pipelineValueFormatted: z.string(),
  mrrFormatted: z.string(),
  pendingSignaturesCount: z.number().int().nonnegative(),

  byStatus: z
    .array(
      z.object({
        status: z.string(),
        pillClass: z.enum(["", "ok", "warn", "danger", "muted"]).default(""),
        count: z.number().int().nonnegative(),
        valueFormatted: z.string(),
      })
    )
    .default([]),

  recentPayments: z
    .array(
      z.object({
        invoiceNumber: z.string(),
        counterpartyDisplayName: z.string(),
        amountFormatted: z.string(),
        paidAt: z.string(),
      })
    )
    .default([]),

  pendingByEngagement: z
    .array(
      z.object({
        slug: z.string(),
        name: z.string(),
        requiredSigners: z.string(),
        oldestPendingAt: z.string(),
        stalenessLabel: z.string().default(""),
        stalenessPillClass: z
          .enum(["", "ok", "warn", "danger", "muted"])
          .default(""),
      })
    )
    .default([]),
})
export type AgencyOverviewSnapshot = z.infer<
  typeof agencyOverviewSnapshotSchema
>

/** Default freshness threshold (ms): how long a snapshot is considered "fresh". */
export const AGENCY_OVERVIEW_FRESHNESS_MS = 30 * 60 * 1000

/**
 * Compute `isStale` from a snapshot's `generatedAt` timestamp. Pure helper —
 * the writing procedure can call it before persisting, the reader can call
 * it on load to refresh the flag.
 */
export function isAgencyOverviewSnapshotStale(
  snapshot: { generatedAt: string },
  thresholdMs: number = AGENCY_OVERVIEW_FRESHNESS_MS,
  now: Date = new Date()
): boolean {
  const generated = Date.parse(snapshot.generatedAt)
  if (Number.isNaN(generated)) return true
  return now.getTime() - generated > thresholdMs
}

export const agencyOverviewVariablesSchema = z.object({
  agencyName: z.string().min(1),
  /** Used to construct per-engagement deep-links in the dashboard. */
  agencySlug: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "Expected lowercase slug (alphanumeric + hyphens)"
    ),
  /** ISO 4217 currency for the headline stats. */
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("EUR"),
})
export type AgencyOverviewVariables = z.infer<
  typeof agencyOverviewVariablesSchema
>

export function agencyOverviewVariables(
  input: AgencyOverviewVariables
): Record<string, string> {
  return {
    agencyName: input.agencyName,
    agencySlug: input.agencySlug,
    currency: input.currency ?? "EUR",
  }
}
