/**
 * Types for `replicate-model-page.mjs` - hand-written alongside the plain-JS
 * module so both TypeScript callers and the bare-`node` sync script import the
 * same implementation. Same arrangement as `minimax-pricing-page.d.mts`.
 *
 * `MediaPriceUnit` is mirrored here (rather than imported from
 * `@agentproto/model-catalog`) because plain `node` sync scripts load this
 * module source directly, without the workspace package resolution.
 */

export type MediaPriceUnit =
  | "per_image"
  | "per_second"
  | "per_1k_chars"
  | "per_minute"
  | "per_token"

export interface ReplicateTierPrice {
  metric: string
  unit: MediaPriceUnit
  priceUsd: number
  title: string
  priceRaw: string
  criteria: unknown[]
}

export interface ReplicateTopLevelPrice {
  raw: string
  amount: number
  unit?: MediaPriceUnit
}

export interface ParsedReplicateModelPage {
  owner: string
  name: string
  hardware?: string
  billingConfig: unknown | null
  hardwarePrice: ReplicateTopLevelPrice | null
  p50PriceUsd: number | undefined
  tierPrices: ReplicateTierPrice[]
}

export interface ReplicateSelectedPrice {
  unit: MediaPriceUnit
  priceUsd: number
  metric: string
  title: string
}

export function parseReplicateModelPage(html: string): ParsedReplicateModelPage

export function selectReplicatePrice(
  page: ParsedReplicateModelPage
): ReplicateSelectedPrice | null

export function distinctTierPrices(page: ParsedReplicateModelPage): ReplicateTierPrice[]
