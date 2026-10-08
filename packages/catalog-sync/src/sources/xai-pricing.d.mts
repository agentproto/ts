/**
 * Types for `xai-pricing.mjs` — hand-written alongside the plain-JS module
 * so both TypeScript callers and the bare-`node` sync script import the same
 * implementation. Same arrangement as `openai-catalog.d.mts`.
 */

import type { PromptLengthTier } from "./openrouter-prompt-tiers.d.mts"

export interface XaiPricingRow {
  id: string
  inputPer1M: number
  outputPer1M: number
  cacheReadMultiplier?: number
  tiers?: PromptLengthTier[]
}

export function xaiPricingRow(m: Record<string, unknown>): XaiPricingRow | undefined
