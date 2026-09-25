/**
 * Types for `openai-catalog.mjs` — hand-written alongside the plain-JS module
 * so both TypeScript callers (the tests) and the bare-`node` sync script can
 * import the same implementation. Same arrangement as
 * `generators/google-native-model-ids.d.mts`.
 */

/** Which list an id came from. */
export type OpenAiIdSource = "openai" | "openrouter"
/** Which source supplied a row's numbers. */
export type OpenAiPriceSource = "openai" | "openrouter"

/** A price pair (+ optional cache ratios) in USD per 1M tokens. */
export interface OpenAiPrice {
  inputPer1M: number
  outputPer1M: number
  cacheReadMultiplier?: number
  cacheWriteMultiplier?: number
}

/** One row of OpenAI's docs pricing table, in USD per 1M tokens. */
export interface OfficialPriceRow {
  inputPer1M: number
  outputPer1M: number
  cachedInputPer1M: number | null
  cacheWritePer1M: number | null
}

/** Per-tier official price tables parsed from the docs pricing page. */
export interface OfficialPricing {
  standard: Map<string, OfficialPriceRow>
  batch: Map<string, OfficialPriceRow>
}

/** A merged catalog row, ready to render. */
export interface MergedOpenAiEntry extends OpenAiPrice {
  id: string
  priceSource: OpenAiPriceSource
  idSource: OpenAiIdSource
}

export interface MergeOpenAiCatalogInput {
  /** Ids from `GET /v1/models`, or null/undefined when no key was available. */
  openAiIds?: Iterable<string> | null
  /** Bare-id → price, from {@link buildOpenRouterPriceMap}. */
  openRouterPrices?: Map<string, OpenAiPrice> | null
  /** Parsed docs pricing, or null when unavailable/untrusted. */
  officialPricing?: OfficialPricing | null
}

export interface MergeOpenAiCatalogResult {
  entries: MergedOpenAiEntry[]
  unpricedIds: string[]
}

export declare const OPENAI_NON_LLM_ID_REGEX: RegExp
export declare const AMBIGUOUS_BARE_IDS: Set<string>
export declare const OFFICIAL_PRICING_SENTINEL_IDS: string[]
export declare const OFFICIAL_PRICING_MIN_ROWS: number

export declare function isOpenAiLlmId(id: unknown): boolean
export declare function round6(num: number): number
export declare function parseDollars(cell: unknown): number | null
export declare function parseOpenAiDocsPricing(markdown: unknown): OfficialPricing
export declare function checkOfficialPricingUsable(
  parsed: OfficialPricing | null | undefined
): string | null
export declare function buildOpenRouterPriceMap(
  models: ReadonlyArray<unknown> | null | undefined
): Map<string, OpenAiPrice>
export declare function lookupOfficialPrice(
  id: string,
  official: OfficialPricing | null | undefined
): OpenAiPrice | null
export declare function mergeOpenAiCatalog(
  input: MergeOpenAiCatalogInput
): MergeOpenAiCatalogResult
export declare function renderEntry(entry: MergedOpenAiEntry): string
export declare function renderGeneratedFile(input: {
  entries: MergedOpenAiEntry[]
  unpricedIds: string[]
  syncedAt: string
  idSourceLabel: string
  priceSourceLabel: string
  officialPricingNote?: string
}): string
