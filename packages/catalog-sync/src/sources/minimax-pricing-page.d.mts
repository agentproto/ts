/**
 * Types for `minimax-pricing-page.mjs` — hand-written alongside the plain-JS
 * module so both TypeScript callers and the bare-`node` sync script import
 * the same implementation. Same arrangement as `openai-catalog.d.mts`.
 */

import type { PromptLengthTier } from "./openrouter-prompt-tiers.d.mts"

/** USD per 1M tokens; cache ratios are relative to `inputPer1M`. */
export interface MiniMaxPrice {
  inputPer1M: number
  outputPer1M: number
  cacheReadMultiplier?: number
  cacheWriteMultiplier?: number
  tiers?: PromptLengthTier[]
}

export function parseMiniMaxPricingPage(markdown: string): Map<string, MiniMaxPrice>

export function checkMiniMaxPricingUsable(prices: Map<string, unknown>): string | null
