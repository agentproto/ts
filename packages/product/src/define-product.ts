/**
 * AIP-55 PRODUCT — `defineProduct` reference implementation.
 *
 * The pricing capability constructor. Attaches a price to any AIP
 * artifact through an `ArtifactRef` — the target needs zero pricing
 * awareness. Cross-field rules (rail/price agreement) run here, the
 * same place every AIP's cross-field rules live.
 */

import type { BillingRail, ProductDefinition, ProductHandle, ProductPrice } from "./types.js"
import { ProductRefError } from "./types.js"
import { refFromUri, type ArtifactRef } from "@agentproto/ref"

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
 * Normalize the `on` target to an `ArtifactRef`: the object form is
 * validated as-is; a string must be a well-formed `aip://` URI and is
 * parsed with `refFromUri` (AIP-54).
 */
function normalizeOn(on: ProductDefinition["on"]): ArtifactRef {
  if (typeof on === "string") {
    try {
      return refFromUri(on)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      throw new ProductRefError(
        `'on' is not a valid aip:// URI — expected aip://<aip>/<id>[@version], got '${on}' (${detail})`,
      )
    }
  }
  if (!on || typeof on.aip !== "number" || typeof on.id !== "string" || !on.id) {
    throw new ProductRefError(`'on' must be a valid AIP-54 ArtifactRef ({aip, id}) or an aip:// URI`)
  }
  return on
}

/**
 * Define a pricing capability on any referenced artifact.
 *
 * Cross-field rules:
 *  - `id` kebab-case.
 *  - price amounts are minor-unit integers; currency is ISO-4217 lowercase.
 *  - `pay-per-call` + `rail: "stripe"` requires `billingRail.meterId`.
 *  - `on` is either an AIP-54 `ArtifactRef` or an `aip://` URI, and is
 *    normalized to the object form on the returned handle.
 */
export function defineProduct(def: ProductDefinition): ProductHandle {
  if (!ID_RE.test(def.id)) throw new ProductRefError(`bad product id '${def.id}'`)
  if (def.kind !== "pricing") throw new ProductRefError(`kind must be 'pricing'`)
  const on = normalizeOn(def.on)
  validatePrice(def.price)
  if (def.billingRail) validateRail(def.price, def.billingRail)
  return Object.freeze({ ...def, on, schema: "product/v1" })
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
  const ref = normalizeOn(on)
  return defineProduct({
    id: opts?.id ?? `pricing-${price.model}-${ref.aip}-${ref.id}`,
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
 * priced things". Returns BOTH outcomes: `resolved` pairs each product
 * whose `on` ref resolves in the catalog with its resolved handle, and
 * `dangling` reports every product whose ref did not resolve — reported,
 * never silently dropped.
 */
export function collectPriced(
  products: readonly ProductHandle[],
  resolve: (ref: ArtifactRef) => { handle: unknown } | undefined,
): {
  resolved: { product: ProductHandle; handle: unknown }[]
  dangling: { product: ProductHandle; ref: ArtifactRef }[]
} {
  const resolved: { product: ProductHandle; handle: unknown }[] = []
  const dangling: { product: ProductHandle; ref: ArtifactRef }[] = []
  for (const p of products) {
    const hit = resolve(p.on)
    if (hit) resolved.push({ product: p, handle: hit.handle })
    else dangling.push({ product: p, ref: p.on })
  }
  return { resolved, dangling }
}
