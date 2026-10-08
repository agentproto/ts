/**
 * Types for `openrouter-prompt-tiers.mjs` — hand-written alongside the
 * plain-JS module so both TypeScript callers and the bare-`node` sync scripts
 * import the same implementation. Same arrangement as `openai-catalog.d.mts`.
 */

/** Mirrors model-catalog's `LLMPricingTier`. */
export interface PromptLengthTier {
  aboveInputTokens: number
  inputPer1M: number
  outputPer1M: number
  cacheReadMultiplier?: number
  cacheWriteMultiplier?: number
}

export function promptLengthTiers(
  pricing: Record<string, unknown> | undefined
): PromptLengthTier[] | undefined

export function serializeTiers(tiers: readonly PromptLengthTier[]): string
