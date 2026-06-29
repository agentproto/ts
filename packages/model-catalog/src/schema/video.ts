import { z } from "zod"
import { baseEntryShape } from "./base.js"

export const VideoCapabilitiesSchema = z.object({
  textToVideo: z.boolean(),
  imageToVideo: z.boolean(),
  subjectReference: z.boolean(),
  audio: z.boolean(),
})
export type VideoCapabilities = z.infer<typeof VideoCapabilitiesSchema>

export const VideoResolutionSchema = z.enum([
  "480p",
  "540p",
  "720p",
  "1080p",
  "1440p",
  "4k",
])
export type VideoResolution = z.infer<typeof VideoResolutionSchema>

/**
 * Mirrors `CostMultipliers` from `the app integration-core`. Keys are
 * stringified so JSON round-trips cleanly.
 */
export const VideoCostMultipliersSchema = z.object({
  resolution: z.record(z.string(), z.number().positive()).optional(),
  duration: z.record(z.string(), z.number().positive()).optional(),
  mode: z.record(z.string(), z.number().positive()).optional(),
})
export type VideoCostMultipliers = z.infer<typeof VideoCostMultipliersSchema>

export const VideoPricingSchema = z.object({
  costPerClip: z.number().nonnegative().optional(),
  costTier: z.enum(["low", "medium", "high"]).optional(),
  billingUnit: z.enum(["per_clip", "per_second"]),
  baseCost: z.number().nonnegative(),
  baseCostUnit: z.string(),
  /** Provider-cost multipliers (resolution / duration / mode). */
  multipliers: VideoCostMultipliersSchema.optional(),
  /** @deprecated Derived at call time. */
  creditCost: z.number().nonnegative().optional(),
  /**
   * @deprecated Use `multipliers` (provider-side) + per-category markup
   * in `pricing-registry`. The credit multipliers used to be a parallel
   * structure; now the formula re-applies `multipliers` to the derived
   * credit count automatically.
   */
  creditMultipliers: VideoCostMultipliersSchema.optional(),
  /** Strategic per-model override — bypasses the formula. */
  overrideCreditCost: z.number().nonnegative().optional(),
})
export type VideoPricing = z.infer<typeof VideoPricingSchema>

export const VideoEntrySchema = z.object({
  ...baseEntryShape,
  kind: z.literal("video"),
  capabilities: VideoCapabilitiesSchema,
  maxDuration: z.number().positive(),
  supportedResolutions: z.array(VideoResolutionSchema).min(1),
  supportedAspectRatios: z.array(z.string()).min(1),
  pricing: VideoPricingSchema,
})
export type VideoEntry = z.infer<typeof VideoEntrySchema>
