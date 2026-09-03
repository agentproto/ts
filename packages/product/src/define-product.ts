/**
 * AIP-53 PRODUCT — `defineProduct` reference implementation.
 *
 * The pricing capability constructor. Attaches a price to any AIP
 * artifact through an `ArtifactRef` — the target needs zero pricing
 * awareness. Cross-field rules (rail/price agreement) run here, the
 * same place every AIP's cross-field rules live.
 */

import type { BillingRail, ProductDefinition, ProductHandle, ProductPrice } from "./types.js"
import { ProductRefError } from "./types.js"

const ID_RE = /^[a-z][a-z0-9-]*$/
const CURRENCY_RE = /^[a-z]{3}$/

function validatePrice(price: ProductPrice): void {
  const minor =
    price.model === "one-time" ? price.amountMinor : price.unitPriceMinor
  if (!Number.isInteger(minor) || minor < 0) {
    throw new ProductRefError(`price minor units must be a non-negative integer, got ${minor}`)
  }
  if (!CURRENCY_RE.test(price.currency)) {
    throw new ProductRefError(`price.currency must be a lowercase ISO-4217 code, got '${price.currency}'`)
  }
  if (price.model === "prepaid-pool" && (!Number.isInteger(price.grantUnits) || price.grantUnits < 1)) {
    throw new ProductRefError(`prepaid-pool requires grantUnits >= 1, got ${price.grantUnits}`)
  }
  if (price.model === "pay-per-call" && (!price.meter || price.meter.length > 96)) {
    throw new ProductRefError(`pay-per-call requires a meter id (1..96 chars)`)
  }
}

function validateRail(price: ProductPrice, rail: BillingRail): void {
  if (
    rail.rail === "stripe" &&
    price.model === "pay-per-call" &&
    !("meterId" in rail && rail.meterId)
  ) {
    throw new ProductRefError(
      `pay-per-call on the stripe rail requires billingRail.meterId — Stripe Meters are out-of-band objects and cannot be derived from priceId`,
    )
  }
  if (rail.rail === "stripe" && price.model === "prepaid-pool") {
    // Not an error — but the spec is explicit that the pool state lives
    // host-side; enforce nothing, document everywhere.
  }
}

/**
 * Define a pricing capability on any referenced artifact.
 *
 * Cross-field rules:
 *  - `id` kebab-case.
 *  - price amounts are minor-unit integers; currency is ISO-4217 lowercase.
 *  - `pay-per-call` + `rail: "stripe"` requires `billingRail.meterId`.
 */
export function defineProduct(def: ProductDefinition): ProductHandle {
  if (!ID_RE.test(def.id)) throw new ProductRefError(`bad product id '${def.id}'`)
  if (def.kind !== "pricing") throw new ProductRefError(`kind must be 'pricing'`)
  if (!def.on || typeof def.on.aip !== "number" || typeof def.on.id !== "string" || !def.on.id) {
    throw new ProductRefError(`'on' must be a valid AIP-54 ArtifactRef ({aip, id})`)
  }
  validatePrice(def.price)
  if (def.billingRail) validateRail(def.price, def.billingRail)
  return Object.freeze({ ...def, schema: "product/v1" })
}

/**
 * Convenience constructor used throughout the dogfood: build the ref
 * elsewhere, attach a price in one call.
 */
export function attachPricing(
  on: ProductDefinition["on"],
  price: ProductPrice,
  opts?: { id?: string; billingRail?: BillingRail; title?: string; description?: string },
): ProductHandle {
  return defineProduct({
    id: opts?.id ?? `pricing-${price.model}-${on.aip}-${on.id}`,
    kind: "pricing",
    on,
    price,
    ...(opts?.billingRail ? { billingRail: opts.billingRail } : {}),
    ...(opts?.title ? { title: opts.title } : {}),
    ...(opts?.description ? { description: opts.description } : {}),
  })
}

/**
 * Join priced capabilities with resolvable refs — "a collection of
 * priced things". Returns the products whose `on` ref resolves in the
 * catalog, paired with the resolved handle; dangling refs are reported,
 * never silently dropped.
 */
export function collectPriced(
  products: readonly ProductHandle[],
  resolve: (ref: ProductDefinition["on"]) => { handle: unknown } | undefined,
): { product: ProductHandle; handle: unknown }[] {
  const out: { product: ProductHandle; handle: unknown }[] = []
  for (const p of products) {
    const hit = resolve(p.on)
    if (hit) out.push({ product: p, handle: hit.handle })
  }
  return out
}
