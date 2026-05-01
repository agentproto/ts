import { z } from "zod"
import {
  currencyIsoSchema,
  envelope,
  isoDatetimeOrDateSchema,
  kebabSlugSchema,
  partyRefStrictSchema,
  workspacePathSchema,
} from "./_common.js"

/**
 * agentagencies/v1 — `ENGAGEMENT.md` doctype.
 *
 * Commercial instance of a service for a counterparty. Aggregates the work
 * (PROJECT.md), the contract (AGREEMENT.md), the deliverables, the invoices,
 * and the active procedure being executed.
 *
 * Lifecycle = the workflow's current step. ENGAGEMENT.md `status` is a
 * denormalization for filesystem-scan filtering, NOT the source of truth.
 */

export const ENGAGEMENT_KIND = [
  "one_shot",
  "milestone",
  "retainer",
  "usage_metered",
] as const
export const engagementKindSchema = z.enum(ENGAGEMENT_KIND)
export type EngagementKind = z.infer<typeof engagementKindSchema>

/**
 * Wide engagement status enum for denormalized filesystem-scan filtering.
 * The authoritative state is the workflow's current step.
 */
export const ENGAGEMENT_STATUS = [
  "scoping",
  "quoted",
  "signed",
  "in_progress",
  "review_requested",
  "revision",
  "validated",
  "invoiced",
  "paid",
  "closed",
  "cancelled",
  "disputed",
] as const
export const engagementStatusSchema = z.enum(ENGAGEMENT_STATUS)
export type EngagementStatus = z.infer<typeof engagementStatusSchema>

const engagementPartySchema = z.object({
  /** Role in the engagement (e.g., "client", "primary-contact", "executor"). */
  role: z.string().min(1),
  /** Canonical "<kind>:<slug>" — counterparty:..., operator:..., agent:..., etc. */
  party: partyRefStrictSchema,
  /** Optional revenue-share percentage (0-100). Sum across parties may exceed 100 (multi-step splits). */
  share: z.number().min(0).max(100).optional(),
})

export const engagementFrontmatterSchema = z.object({
  ...envelope("engagement"),

  kind: engagementKindSchema,
  status: engagementStatusSchema,

  /** All parties — roles + canonical refs. */
  parties: z.array(engagementPartySchema).min(1),

  /** Denormalized: primary counterparty for fast queries. */
  primaryCounterpartyId: kebabSlugSchema,

  /** Service slug being delivered. */
  serviceSlug: kebabSlugSchema.optional(),

  /** Active procedure being executed (PROCEDURE.md slug). */
  activeProcedure: kebabSlugSchema.optional(),
  /** Active step within the procedure (step id). */
  activeStep: kebabSlugSchema.optional(),

  /** Path to the AGREEMENT.md (relative to engagement folder). */
  agreementPath: z.string().default("AGREEMENT.md"),

  /** Path to the linked PROJECT.md (companies.sh) — the work. */
  projectPath: workspacePathSchema.optional(),

  /** Pricing model in effect for this engagement. */
  pricingModelSlug: kebabSlugSchema.optional(),

  totalContractValue: z.number().nonnegative().optional(),
  currency: currencyIsoSchema.optional(),

  /** Affiliate referral link (refs core/affiliate domain if present). */
  referredByAffiliateId: kebabSlugSchema.optional(),

  // Lifecycle timestamps (denorm of audit-log + workflow state).
  scopedAt: isoDatetimeOrDateSchema.optional(),
  signedAt: isoDatetimeOrDateSchema.optional(),
  startedAt: isoDatetimeOrDateSchema.optional(),
  validatedAt: isoDatetimeOrDateSchema.optional(),
  paidAt: isoDatetimeOrDateSchema.optional(),
  closedAt: isoDatetimeOrDateSchema.optional(),
})
export type EngagementFrontmatter = z.infer<typeof engagementFrontmatterSchema>

export interface Engagement {
  frontmatter: EngagementFrontmatter
  body: string
}

export const ENGAGEMENT_FILENAME = "ENGAGEMENT.md" as const
