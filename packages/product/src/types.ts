/**
 * AIP-55 PRODUCT — pricing capability types.
 *
 * A product is a pricing CAPABILITY attached to any referenced AIP
 * artifact via an AIP-54 `ArtifactRef` — not a wrapper doctype with a
 * bespoke target union. The target AIP (app, pack, tool, sandbox, …)
 * needs zero awareness of pricing.
 *
 * The price union and billingRail config are the commerce surface
 * designed in the AIP-55 draft and preserved verbatim here.
 */

import type { ArtifactRef } from "@agentproto/ref-catalog"

/** What is charged. Minor units are normative — the ×100 bug class lives in floats. */
export type ProductPrice =
  | { readonly model: "one-time"; readonly amountMinor: number; readonly currency: string }
  | {
      readonly model: "prepaid-pool"
      readonly unitPriceMinor: number
      readonly currency: string
      readonly grantUnits: number
    }
  | {
      readonly model: "pay-per-call"
      readonly unitPriceMinor: number
      readonly currency: string
      readonly meter: string
    }

/** Projection config — never the price's source of truth. */
export type BillingRail =
  | {
      readonly rail: "stripe"
      readonly productId?: string
      readonly priceId?: string
      /** Stripe Meter id — REQUIRED for pay-per-call (meters are out-of-band objects). */
      readonly meterId?: string
      readonly recurrence?: "month" | "year" | "week" | "day"
    }
  | { readonly rail: "autumn"; readonly featureId?: string; readonly grantId?: string }
  | { readonly rail: "tbd" }
  | { readonly rail: string & {}; readonly config?: Record<string, unknown> }

/** The pricing capability payload, as authored. */
export interface ProductDefinition {
  readonly id: string
  readonly kind: "pricing"
  /** The referenced artifact this pricing attaches to (AIP-54). */
  readonly on: ArtifactRef
  readonly price: ProductPrice
  readonly billingRail?: BillingRail
  readonly title?: string
  readonly description?: string
}

/** The frozen handle `defineProduct` returns. */
export interface ProductHandle extends Readonly<ProductDefinition> {
  readonly schema: "product/v1"
}

export class ProductRefError extends Error {
  constructor(message: string) {
    super(`defineProduct (AIP-55): ${message}`)
    this.name = "ProductRefError"
  }
}
