/**
 * Usage pricing types: what a metered action is, and how a category turns its
 * provider cost into minor units of the primary asset. Pure data, no product
 * names. The credit rate is never written here: it is derived from the
 * manifest's `anchor` and `fx` (`entryRatio`).
 */

/** A money amount at the provider, in MAJOR units of `currency` (e.g. 0.0021 USD). */
export interface ProviderCost {
  amount: number
  currency: string
}

/** A metered action as the host observed it. */
export interface UsageEvent {
  /** What was used: `llm`, `stt`, `tts`, `image`, `messaging-fee`... (free vocabulary). */
  kind: string
  model?: string
  channel?: string
  op?: string
  /** How many units (tokens, seconds, characters, calls). Default 1. */
  units?: number
  /** The cost the provider reported or the host measured, in major units. */
  providerCost?: ProviderCost
  /** Who supplied the credential for the call (e.g. the platform or the customer). An opaque tag: the kit copies it to the result and the shadow entry and never reads it. */
  credentialSource?: string
  /** Idempotency key of this action: a replay writes nothing twice. */
  key: string
  accountId: string
}

export type CostSpec =
  /** The event carries the real cost (`providerCost`). Absent is an error, never zero. */
  | { source: "measured" }
  /** A constant cost per unit, in major units. */
  | { source: "fixed"; amount: number; currency: string }
  /** The host's price book answers per event (`PriceBook`). */
  | { source: "catalog" }

export interface UsageCategory {
  id: string
  /** Every given field must equal the event's; `{}` or absent matches everything. The most specific match wins. */
  match?: { kind?: string; model?: string; channel?: string; op?: string }
  cost: CostSpec
  /** A multiplier on the cost, or `at-cost` (1.0, never overridden by `defaults`). */
  margin?: number | "at-cost"
  /** A lowest real margin (price / cost) the host wants checked by `assertMarginFloors`. The kit sets no value of its own. */
  marginFloor?: number
  /** Smallest charge per action in minor units. Default: `defaults.floorMinor`, else 0 (no floor). */
  floorMinor?: number
}

export interface UsageConfig {
  categories: readonly UsageCategory[]
  defaults?: { margin?: number; floorMinor?: number }
}

/** The host's price book: cost of one event, or null when it has no price for it. */
export interface PriceBook {
  cost(event: UsageEvent): ProviderCost | null
}

export interface PriceResult {
  /** What to charge, in minor units of the primary asset. */
  minor: number
  categoryId: string
  /** The margin applied (1 for `at-cost`). */
  margin: number
  /** Provider cost in minor units of the primary asset, before margin (exact, not rounded). */
  costMinor: number
  /** minor / costMinor, when the cost is known. */
  realMargin: number | undefined
  atCost: boolean
  /** Copied from the event, unread. */
  credentialSource?: string
}

export class UnpricedUsageError extends Error {
  constructor(
    readonly reason: "no-category" | "no-cost" | "unknown-currency" | "invalid-units" | "invalid-cost",
    message: string,
  ) {
    super(message)
    this.name = "UnpricedUsageError"
  }
}
