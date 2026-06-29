import { z } from "zod"
import { baseEntryShape } from "./base.js"

export const ImageCapabilitiesSchema = z.object({
  generate: z.boolean(),
  edit: z.boolean(),
  upscale: z.boolean().optional(),
})
export type ImageCapabilities = z.infer<typeof ImageCapabilitiesSchema>

export const ImageReferenceImagesSchema = z.object({
  supported: z.boolean(),
  fieldName: z.enum(["image_input", "input_images", "input_image", "none"]),
  maxCount: z.number().int().nonnegative(),
  singular: z.boolean(),
})
export type ImageReferenceImages = z.infer<typeof ImageReferenceImagesSchema>

export const ImageAspectRatioSchema = z.object({
  supported: z.array(z.string()).min(1),
  default: z.string(),
})
export type ImageAspectRatio = z.infer<typeof ImageAspectRatioSchema>

/**
 * Pricing inputs for a model entry.
 *
 * Credit math is **derived at call time** by `computeCenticredits()` from
 * `baseCost × category-markup`. The catalog only carries the
 * production-cost input. An entry can opt out of the formula via
 * `overrideCreditCost` (strategic subsidy / partner pricing) — used
 * sparingly so a category-wide tune stays a one-line change in
 * `pricing/index.ts`.
 *
 * `costPerImage` / `costTier` / `creditCost` are deprecated but kept
 * readable so production data + admin UI keep parsing. New entries
 * should not set them.
 */
export const ImagePricingSchema = z.object({
  costPerImage: z.number().nonnegative().optional(),
  costTier: z.enum(["low", "medium", "high"]).optional(),
  billingUnit: z.literal("per_image"),
  baseCost: z.number().nonnegative(),
  /** @deprecated Derived at call time. Kept for back-compat. */
  creditCost: z.number().nonnegative().optional(),
  /**
   * Strategic per-model override. When set, bypasses the formula and
   * the user is charged this many credits per output regardless of
   * provider cost or category markup.
   */
  overrideCreditCost: z.number().nonnegative().optional(),
})
export type ImagePricing = z.infer<typeof ImagePricingSchema>

export const ImageEntrySchema = z.object({
  ...baseEntryShape,
  kind: z.literal("image"),
  capabilities: ImageCapabilitiesSchema,
  referenceImages: ImageReferenceImagesSchema,
  aspectRatio: ImageAspectRatioSchema,
  output: z.enum(["string", "array"]),
  pricing: ImagePricingSchema,
  triggerWord: z.string().optional(),
})
export type ImageEntry = z.infer<typeof ImageEntrySchema>
