import { z } from "zod"
import { currencyIsoSchema, envelope, isoDurationSchema } from "./_common.js"

/**
 * agentagencies/v1 — `PRICING-MODEL.md` doctype.
 *
 * Pricing rule. Determines how a service is priced + how it gets billed.
 * Six kinds for v1:
 *   - fixed         — single price for the whole engagement
 *   - hourly        — billed per hour worked (with optional cap)
 *   - retainer      — recurring monthly/period fee
 *   - milestone     — scheduled payments at defined milestones
 *   - value         — outcome-based (e.g., % of revenue impact)
 *   - usage_metered — Stripe-style usage billing
 */

export const PRICING_KIND = [
  "fixed",
  "hourly",
  "retainer",
  "milestone",
  "value",
  "usage_metered",
] as const
export const pricingKindSchema = z.enum(PRICING_KIND)
export type PricingKind = z.infer<typeof pricingKindSchema>

const fixedPricingSchema = z.object({
  kind: z.literal("fixed"),
  amount: z.number().positive(),
  currency: currencyIsoSchema,
})

const hourlyPricingSchema = z.object({
  kind: z.literal("hourly"),
  rate: z.number().positive(),
  currency: currencyIsoSchema,
  /** Optional cap on total hours billable. */
  capHours: z.number().positive().optional(),
})

const retainerPricingSchema = z.object({
  kind: z.literal("retainer"),
  amount: z.number().positive(),
  currency: currencyIsoSchema,
  /** ISO duration of one billing period (e.g., P1M for monthly). */
  period: isoDurationSchema,
  /** Minimum commitment as ISO duration (e.g., P12M for 12 months). */
  minCommitment: isoDurationSchema.optional(),
})

const milestonePricingSchema = z.object({
  kind: z.literal("milestone"),
  currency: currencyIsoSchema,
  milestones: z
    .array(
      z.object({
        slug: z.string(),
        description: z.string().optional(),
        amount: z.number().positive(),
        /** Optional ISO date or duration relative to engagement start. */
        dueAt: z.string().optional(),
      })
    )
    .min(1),
})

const valuePricingSchema = z.object({
  kind: z.literal("value"),
  currency: currencyIsoSchema,
  /** Free-form outcome formula description. */
  formula: z.string(),
  baseFee: z.number().nonnegative().optional(),
  capAmount: z.number().positive().optional(),
})

const usageMeteredPricingSchema = z.object({
  kind: z.literal("usage_metered"),
  currency: currencyIsoSchema,
  unit: z.string(), // e.g., "request", "minute", "GB"
  ratePerUnit: z.number().positive(),
  /** Optional included quota before metering kicks in. */
  includedUnits: z.number().nonnegative().optional(),
  /** Stripe-compatible meter id (vendor extension). */
  externalMeterId: z.string().optional(),
})

export const pricingDetailsSchema = z.discriminatedUnion("kind", [
  fixedPricingSchema,
  hourlyPricingSchema,
  retainerPricingSchema,
  milestonePricingSchema,
  valuePricingSchema,
  usageMeteredPricingSchema,
])
export type PricingDetails = z.infer<typeof pricingDetailsSchema>

export const pricingModelFrontmatterSchema = z.object({
  ...envelope("pricing-model"),
  details: pricingDetailsSchema,
  /** Default tax handling (vendor extensions in metadata.<vendor>.tax.*). */
  taxIncluded: z.boolean().optional(),
})
export type PricingModelFrontmatter = z.infer<
  typeof pricingModelFrontmatterSchema
>

export interface PricingModel {
  frontmatter: PricingModelFrontmatter
  body: string
}

export const PRICING_MODEL_FILENAME = "PRICING-MODEL.md" as const
