/**
 * Media price catalog contract - the route-keyed shape emitted by the
 * media sync generators (`packages/catalog-sync`) and consumed by pricing /
 * picker surfaces.
 *
 * Keys follow the same convention as the LLM route catalog:
 *   - `vendor/model`          an OpenRouter route (e.g. `openai/gpt-image-1`)
 *   - `replicate:owner/name`  a Replicate model page (e.g.
 *                             `replicate:black-forest-labs/flux-schnell`)
 *
 * Deliberately separate from `ImageModelDefinition.pricing` / `AudioPricing`:
 * those describe how a provider bills a specific integration call, while this
 * is the raw scraped price + its unit, with provenance and a fetch date.
 */

export type MediaPriceUnit =
  | "per_image"
  | "per_second"
  | "per_1k_chars"
  | "per_minute"
  | "per_token"

export interface MediaPricing {
  /** What `priceUsd` is charged for. */
  unit: MediaPriceUnit
  /** Price in USD for one `unit`. */
  priceUsd: number
  /** Where the price came from (`openrouter`, `replicate`, ...). */
  source: string
  /** ISO date (`YYYY-MM-DD`) the price was first observed at this value. */
  fetchedAt: string
}

/** Route-keyed media price map. */
export type MediaPricingCatalog = Record<string, MediaPricing>
