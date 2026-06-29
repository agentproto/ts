/**
 * Billing-unit + cost-multiplier types — inlined here so this package stays
 * dependency-light (zod-only). Previously imported from
 * `@agstudio/integration-core`; that coupling is severed for the OSS core.
 * `@agstudio/model-catalog` re-exports these for back-compat.
 */

export type BillingUnit =
  | "per_image"
  | "per_second"
  | "per_clip"
  | "per_token"
  | "per_character"

/** Multipliers for resolution/duration/mode pricing variants. */
export interface CostMultipliers {
  resolution?: Record<string, number>
  duration?: Record<number, number>
  mode?: Record<string, number>
}
