/**
 * Types for `kimi-pricing-page.mjs` — hand-written alongside the plain-JS
 * module so both TypeScript callers and the bare-`node` sync script import
 * the same implementation. Same arrangement as `openai-catalog.d.mts`.
 */

/** USD per 1M tokens; cache ratios are relative to `inputPer1M`. */
export interface KimiPrice {
  inputPer1M: number
  outputPer1M: number
  cacheReadMultiplier?: number
  cacheWriteMultiplier?: number
}

export function parseKimiPricingPage(markdown: string): Map<string, KimiPrice>

export function checkKimiPricingUsable(prices: Map<string, unknown>): string | null
