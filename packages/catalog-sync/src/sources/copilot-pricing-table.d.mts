/** Types for `copilot-pricing-table.mjs` (same arrangement as `minimax-pricing-page.d.mts`). */

import type { PromptLengthTier } from "./openrouter-prompt-tiers.d.mts"

export interface CopilotPromo {
  /** ISO date (`YYYY-MM-DD`): the promo is over ON this date; `then` applies from it. */
  until: string
  /** Standard price from `until` on, when Copilot's footnote states it. */
  then?: { inputPer1M: number; outputPer1M: number; cacheReadMultiplier?: number }
}

/** USD per 1M tokens; cache ratios are relative to `inputPer1M`. */
export interface CopilotPrice {
  inputPer1M: number
  outputPer1M: number
  cacheReadMultiplier?: number
  cacheWriteMultiplier?: number
  tiers?: PromptLengthTier[]
  vendor?: string
  promo?: CopilotPromo
}

export function copilotModelId(displayName: string): string
export function parseCopilotPricingYaml(yaml: string): Record<string, string>[]
export function parseCopilotPromoFootnotes(markdown: string): Map<string, CopilotPromo>
export function parseCopilotPricing(yaml: string, markdown?: string): Map<string, CopilotPrice>
export function checkCopilotPricingUsable(prices: Map<string, unknown>): string | null
