/**
 * Types for `models-dev-pricing.mjs` — hand-written alongside the plain-JS
 * module so both TypeScript callers and the bare-`node` sync script import
 * the same implementation.
 */

/** USD per 1M tokens; cache ratios are relative to `inputPer1M`. */
export interface ModelsDevPrice {
  inputPer1M: number
  outputPer1M: number
  cacheReadMultiplier?: number
  cacheWriteMultiplier?: number
}

export function parseModelsDevProviderPricing(payload: unknown, providerId: string): Map<string, ModelsDevPrice>
