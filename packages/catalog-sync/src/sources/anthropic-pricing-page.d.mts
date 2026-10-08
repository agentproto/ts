/**
 * Types for `anthropic-pricing-page.mjs` — hand-written alongside the
 * plain-JS module so both TypeScript callers and the bare-`node` sync script
 * import the same implementation. Same arrangement as `openai-catalog.d.mts`.
 */

import type { PromptLengthTier } from "./openrouter-prompt-tiers.d.mts"

/** USD per 1M tokens; cache ratios are relative to `inputPer1M`. */
export interface AnthropicPrice {
  inputPer1M: number
  outputPer1M: number
  cacheReadMultiplier?: number
  cacheWriteMultiplier?: number
  tiers?: PromptLengthTier[]
}

export function parseAnthropicPricingPage(markdown: string): Map<string, AnthropicPrice>

export function checkAnthropicPricingUsable(prices: Map<string, unknown>): string | null
