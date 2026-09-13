/**
 * Compatibility shim between the extension's client and the daemon's
 * compact-by-default list tools (PRs #1184→#1213 introduced ToolTransformer
 * projections). The client boundary absorbs the shape differences so no
 * consumer call-site changes:
 *
 *  - `catalog_models` compact returns `{ routes: [flat rows] }` where each row
 *    is `{ vendor, product, route, ref, runnable, curated, multiModel }` —
 *    LACKING baseUrl/pricing/eligibleProfiles/adapterModes/adapters. The
 *    extension's types (CatalogModelsResponse / CatalogRoute) still speak the
 *    legacy nested `{ vendors: [...] }` tree, so renestCatalog() re-groups the
 *    flat rows and default-fills the missing fields. A legacy (already-nested)
 *    payload passes through unchanged; with `{ full: true }` the daemon sends
 *    the complete CatalogRoute fields, which renestCatalog simply regroups.
 *
 * Total: empty/invalid input → `{ vendors: [] }`.
 */

import type {
  CatalogModelsResponse,
  CatalogRoute,
} from "./types.js"

/** One flat (compact) `catalog_models` row — `{ vendor, product }` plus
 *  whatever route fields the projection carried. Compact rows carry
 *  route/ref/runnable/curated/multiModel but NOT baseUrl/pricing/
 *  eligibleProfiles/adapterModes/adapters; full rows have them all. */
export type CompactCatalogRow = { vendor: string; product: string } &
  Partial<CatalogRoute> & { ref?: string }

/** Safe defaults for the route fields a compact row lacks. */
const ROUTE_DEFAULTS = {
  baseUrl: null,
  pricing: null,
  eligibleProfiles: [] as string[],
  adapterModes: [] as string[],
  adapters: [] as string[],
} as const

function looksLikeCatalogRow(row: unknown): row is CompactCatalogRow {
  return (
    typeof row === "object" &&
    row !== null &&
    typeof (row as { vendor?: unknown }).vendor === "string" &&
    typeof (row as { product?: unknown }).product === "string"
  )
}

/**
 * Renest the daemon's flat `catalog_models` rows into the legacy
 * `{ vendors: [{ vendor, products: [{ product, routes: [...] }] }] }` tree,
 * preserving row order within each vendor/product. Accepts a legacy nested
 * response unchanged. Total: anything unexpected → `{ vendors: [] }`.
 */
export function renestCatalog(raw: unknown): CatalogModelsResponse {
  // Legacy nested payload — passthrough.
  if (
    typeof raw === "object" &&
    raw !== null &&
    Array.isArray((raw as { vendors?: unknown }).vendors)
  ) {
    return raw as CatalogModelsResponse
  }

  // Compact/flat payload — { routes: [rows] } (rows may also sit top-level
  // if the envelope was already unwrapped).
  let rows: unknown
  if (typeof raw === "object" && raw !== null && "routes" in raw) {
    rows = (raw as { routes?: unknown }).routes
  } else if (Array.isArray(raw)) {
    rows = raw
  }
  if (!Array.isArray(rows)) return { vendors: [] }

  const vendors: CatalogModelsResponse["vendors"] = []
  const vendorIndex = new Map<string, Map<string, CatalogRoute[]>>()
  for (const row of rows) {
    if (!looksLikeCatalogRow(row)) continue
    let products = vendorIndex.get(row.vendor)
    if (!products) {
      products = new Map()
      vendorIndex.set(row.vendor, products)
      vendors.push({ vendor: row.vendor, products: [] })
    }
    let routes = products.get(row.product)
    if (!routes) {
      routes = []
      products.set(row.product, routes)
      vendors
        .find(v => v.vendor === row.vendor)!
        .products.push({ product: row.product, routes })
    }
    routes.push({ ...ROUTE_DEFAULTS, ...row } as CatalogRoute)
  }
  return { vendors }
}
