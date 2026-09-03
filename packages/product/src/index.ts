/**
 * @agentproto/product — AIP-53 reference implementation.
 *
 * The pricing capability: attach a price (one-time | prepaid-pool |
 * pay-per-call) + a billingRail to ANY AIP artifact via an AIP-54
 * ArtifactRef. The target AIP needs zero pricing awareness.
 *
 * @see https://agentproto.sh/docs/aip-53
 */

export const SPEC_NAME = "product/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineProduct, attachPricing, collectPriced } from "./define-product.js"
export {
  ProductRefError,
  type ProductDefinition,
  type ProductHandle,
  type ProductPrice,
  type BillingRail,
} from "./types.js"
