/**
 * The bridge to AIP-55: an offer whose price AIP-55 already types is a product.
 * `subscription`, the pack and buyer-chosen `prepaid-pool` forms and vendor
 * models are not in `@agentproto/product` yet (AIP-55 amendment, companion PR
 * agentproto/agentproto#172): asking for them throws, naming the gap.
 */
import { defineProduct, type ProductDefinition, type ProductHandle } from "@agentproto/product"
import type { Offer } from "./types.js"

export function offerToProduct(offer: Offer, on: ProductDefinition["on"], opts?: { billingRail?: ProductDefinition["billingRail"] }): ProductHandle {
  const p = offer.price
  if (p.model !== "one-time" || typeof p.amountMinor !== "number" || typeof p.currency !== "string") {
    throw new Error(
      `offerToProduct: offer '${offer.id}' has price model '${p.model}', which @agentproto/product does not type yet (AIP-55 amendment, agentproto/agentproto#172)`,
    )
  }
  return defineProduct({
    id: offer.id,
    kind: "pricing",
    on,
    price: { model: "one-time", amountMinor: p.amountMinor, currency: p.currency.toLowerCase() },
    ...(opts?.billingRail ? { billingRail: opts.billingRail } : {}),
  } as ProductDefinition)
}
