import { z } from "zod"
import { baseEntryShape } from "./base.js"

/**
 * LLM pricing — token-based. Mirrors the historical `LLMPricing` shape in
 * `packages/core/src/config/llm-pricing.ts` so the existing
 * `calculateLLMCreditCost` formula carries over verbatim.
 */
export const LlmPricingSchema = z.object({
  inputPer1M: z.number().nonnegative(),
  outputPer1M: z.number().nonnegative(),
  creditInputPer1M: z.number().nonnegative(),
  creditOutputPer1M: z.number().nonnegative(),
  cacheReadMultiplier: z.number().nonnegative().optional(),
  cacheWriteMultiplier: z.number().nonnegative().optional(),
  // Router (how we call the model) vs vendor (who made it). See
  // `LLMPricing` in ../llm/catalog.ts for the contract.
  provider: z.string().optional(),
  vendor: z.string().optional(),
})
export type LlmPricing = z.infer<typeof LlmPricingSchema>

export const LLMEntrySchema = z.object({
  ...baseEntryShape,
  kind: z.literal("llm"),
  pricing: LlmPricingSchema,
  contextWindow: z.number().int().positive().optional(),
})
export type LLMEntry = z.infer<typeof LLMEntrySchema>
