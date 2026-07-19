/**
 * Read-only catalog/vendor endpoint (`agentproto-session-config-axes`
 * SPEC §5) — `GET /catalog/models` + `catalog_models` MCP tool wire into
 * {@link buildCatalogModels}, the pure join this module owns.
 *
 * Reuses three already-shipped pieces instead of rebuilding them:
 *   - the vendor/product/route model + router widening (OpenRouter/
 *     Requesty/HuggingFace) from `@agentproto/model-catalog/route-identity`
 *     (`resolveLlmModelRoute`, `route-identity/index.ts:396-511`) — this is
 *     what keeps the catalog from being capped at any one adapter's
 *     `models.allowed` list (SPEC §5.1);
 *   - the profile eligibility predicate shipped in #470
 *     (`@agentproto/auth`'s `eligibleProfiles`, `packages/auth/src/
 *     eligibility.ts:81-89`) for the profile-aware `runnable` flag (SPEC
 *     §5.3) — the old bare `hasKey` check (`packages/cli/src/commands/
 *     models.ts:113-117`) is the degenerate one-profile-per-provider case
 *     this predicate subsumes;
 *   - `AdapterAuthDescriptor` (`spawn-defaults.ts:226`), the SAME
 *     provider/authSubscription projection `resolveAuthSpec` reads, as the
 *     source for which auth methods an adapter can present on its direct
 *     route (SPEC §3.4's derivable replacement for a hand-maintained
 *     `authSubscription` boolean).
 *
 * A gateway/router route (anything where the resolved route differs from
 * the model's vendor — `openrouter`, `requesty`, `huggingface`, or an
 * adapter's own gateway mode id like `moonshot`) always bills against the
 * route's own id and is always reached with an api-key credential — never
 * oauth-bearer, since no third-party gateway has an Anthropic-style
 * subscription bearer path (SPEC §1c: "a moonshot profile, not the Claude
 * sub"). That structural rule is what lets this module compute
 * `runnable`/`eligibleProfiles` for the widened, non-curated rows without
 * per-adapter gateway-vendor tables.
 */

import type { AuthMethod, AuthProfile } from "@agentproto/auth"
import { eligibleProfiles, type AdapterAuthManifest } from "@agentproto/auth"
import {
  resolveLlmModelRoute,
  tryParseModelRef,
  formatModelRef,
} from "@agentproto/model-catalog/route-identity"
import type { AdapterAuthDescriptor } from "./spawn-defaults.js"

/** Routers the catalog probes to widen beyond any adapter's declared model
 *  list (SPEC §5.1) — same three route-identity widens, `route-identity/
 *  index.ts:54-59`. */
const WIDENING_ROUTES = ["openrouter", "requesty", "huggingface"] as const

/** One model entry as declared in an adapter's `models.allowed`
 *  (`AdapterModelInfo`, `packages/cli/src/registry/resolve.ts:134-142`) —
 *  the subset this module needs. */
export interface CatalogAdapterModelInput {
  /** Model id exactly as declared — bare (`"claude-opus-4-8"`) or
   *  `vendor/product` form. */
  id: string
  /** The adapter mode id that must be applied to reach this model on a
   *  non-direct route (`AdapterModelInfo.mode`) — e.g. `"moonshot"`.
   *  Undefined ⇒ direct route (the model's own vendor). */
  mode?: string
}

/** One installed adapter's contribution to the catalog. */
export interface CatalogAdapterInput {
  slug: string
  models: readonly CatalogAdapterModelInput[]
  /** This adapter's billing-auth capability on its DIRECT route — the same
   *  projection `resolveAuthSpec` reads (`spawn-defaults.ts:226`). Omitted
   *  ⇒ the adapter presents no auth method, so rows it curates are
   *  discoverable but never runnable through it alone. */
  authDescriptor?: AdapterAuthDescriptor
}

export interface CatalogModelsQuery {
  /** Keep only routes reachable via this adapter slug. */
  adapter?: string
  /** Keep only this vendor's entry. */
  vendor?: string
  /** Keep only routes with this route id. */
  route?: string
  /** Drop every route with `runnable: false`. */
  runnableOnly?: boolean
}

export interface CatalogPricing {
  inPer1M: number
  outPer1M: number
}

export interface CatalogRoute {
  route: string
  ref: string
  baseUrl: string | null
  pricing: CatalogPricing | null
  runnable: boolean
  eligibleProfiles: string[]
  adapterModes: string[]
  adapters: string[]
  curated: boolean
}

export interface CatalogProduct {
  product: string
  routes: CatalogRoute[]
}

export interface CatalogVendor {
  vendor: string
  products: CatalogProduct[]
}

export interface CatalogModelsResponse {
  vendors: CatalogVendor[]
}

export interface BuildCatalogModelsInput {
  adapters: readonly CatalogAdapterInput[]
  profiles: readonly AuthProfile[]
  query?: CatalogModelsQuery
}

/** A resolved model identity + pricing, independent of which adapter (if
 *  any) declared it. */
interface ResolvedModel {
  vendor: string
  product: string
  /** The route this id resolves to on its OWN — vendor for a direct id,
   *  a router name when the id already carries `@route`. */
  directRoute: string
  ref: string
  baseUrl: string | null
  pricing: CatalogPricing | null
}

/** Rewrite a router-prefixed id (`<router>/<vendor>/<product>`) into the
 *  canonical route-identity `<vendor>/<product>@<router>` the parser accepts.
 *
 *  Mastra-style adapters (e.g. `adapters/mastra-agent`) declare their model
 *  ids in `<provider>/<upstream-id>` form, and for a gateway router the
 *  upstream id is itself `<vendor>/<product>` — so a native OpenRouter id like
 *  `z-ai/glm-5.2` is advertised as the 3-segment `openrouter/z-ai/glm-5.2`.
 *  `parseModelRef` splits on the FIRST `/` and rejects a product that still
 *  contains one (`route-identity/index.ts` SEGMENT_RE), so feeding it the raw
 *  3-segment string throws and, before this normalization, 500'd the whole
 *  catalog. The route-identity grammar's canonical form for such a model is
 *  `<vendor>/<product>@<router>` (`z-ai/glm-5.2@openrouter`) — the `@route`
 *  suffix, NOT a leading route segment — so we recompose to that. Only the
 *  known gateway routers (whose native ids are `<vendor>/<product>`) are
 *  peeled; every other id is returned untouched. A `:pin` variant/provider
 *  suffix on the upstream id is preserved (it rides along in the remainder).
 */
function normalizeRouterPrefixedId(id: string): string {
  const firstSlash = id.indexOf("/")
  if (firstSlash === -1) return id
  const head = id.slice(0, firstSlash)
  if (!(WIDENING_ROUTES as readonly string[]).includes(head)) return id
  const remainder = id.slice(firstSlash + 1)
  // Only a genuine `<vendor>/<product>` upstream id (still carrying a `/`) is
  // the router-prefixed shape; a 2-segment `<router>/<product>` is left alone.
  if (!remainder.includes("/") || remainder.includes("@")) return id
  return `${remainder}@${head}`
}

/** {@link resolveLlmModelRoute} that never throws. `resolveLlmModelRoute`
 *  parses through the strict `parseModelRef`, which throws on a still-
 *  unparseable ref (e.g. an unrecognised 3-segment id that normalization
 *  didn't rewrite) — defense-in-depth so a single bad id can never 500 the
 *  catalog. */
function tryResolveLlmModelRoute(id: string): ReturnType<typeof resolveLlmModelRoute> {
  try {
    return resolveLlmModelRoute(id)
  } catch {
    return undefined
  }
}

/** Infer a vendor from a bare id family prefix — ports `providerFromIdPrefix`
 *  (`packages/cli/src/commands/models.ts:47-54`) so a model id that predates
 *  its pricing-catalog entry still gets a vendor instead of `"unknown"`. */
function vendorFromIdPrefix(bareId: string): string | undefined {
  if (/^claude[-/]/.test(bareId)) return "anthropic"
  if (/^(gpt[-/]|o[1-9](-|$)|chatgpt)/.test(bareId)) return "openai"
  if (/^gemini[-/]/.test(bareId)) return "google"
  if (/^grok[-/]/.test(bareId)) return "x-ai"
  if (/^deepseek[-/]/.test(bareId)) return "deepseek"
  return undefined
}

/** Resolve a model id to its vendor/product/route/pricing, in three tiers:
 *  the route-identity resolver (handles both `vendor/product[@route]` and
 *  legacy bare ids with pricing), then a bare vendor/product parse with no
 *  pricing, then the id-prefix heuristic as a last resort. Never throws —
 *  every id gets SOME vendor rather than being dropped from the catalog. */
function resolveModelId(id: string): ResolvedModel {
  // A router-prefixed Mastra id (`openrouter/z-ai/glm-5.2`) becomes its
  // canonical route-identity (`z-ai/glm-5.2@openrouter`) BEFORE any parse, so
  // it resolves to a real vendor/product/route row instead of throwing.
  const normalized = normalizeRouterPrefixedId(id)
  const resolved = tryResolveLlmModelRoute(normalized)
  if (resolved) {
    return {
      vendor: resolved.vendor,
      product: resolved.product,
      directRoute: resolved.route,
      ref: formatModelRef(resolved.ref),
      baseUrl: resolved.transport.baseUrl ?? null,
      pricing: {
        inPer1M: resolved.pricing.inputPer1M,
        outPer1M: resolved.pricing.outputPer1M,
      },
    }
  }
  const parsed = tryParseModelRef(normalized)
  if (parsed) {
    return {
      vendor: parsed.vendor,
      product: parsed.product,
      directRoute: parsed.route,
      ref: formatModelRef(parsed),
      baseUrl: null,
      pricing: null,
    }
  }
  const vendor = vendorFromIdPrefix(id) ?? "unknown"
  return {
    vendor,
    product: id,
    directRoute: vendor,
    ref: `${vendor}/${id}`,
    baseUrl: null,
    pricing: null,
  }
}

/** Which auth methods are presentable on a model's DIRECT route — whatever
 *  the adapter's descriptor declares, derivable from `authSubscription`/
 *  `provider` exactly as SPEC §3.4 calls for. Only called for a genuinely
 *  direct route (see `isDirectRoute`); a gateway/router route is always
 *  api-key only (SPEC §1c — no third-party gateway has an oauth-bearer
 *  path), regardless of what the underlying model's own vendor is. */
function methodsForDirect(
  descriptor: AdapterAuthDescriptor | undefined,
): AuthMethod[] {
  const methods: AuthMethod[] = []
  if (descriptor?.authSubscription) methods.push("oauth-bearer")
  if (descriptor?.provider) methods.push("api-key")
  return methods
}

/** True iff this model entry resolves to its OWN vendor with no adapter
 *  mode override — i.e. reached without any gateway/router redirection.
 *  An explicit `model.mode` (adapter gateway mode, e.g. `"moonshot"`) is
 *  ALWAYS a redirection even when the mode id happens to equal the
 *  model's resolved vendor (e.g. a `moonshot/kimi-…` model routed via
 *  claude-code's `moonshot` mode) — SPEC §1c's "moonshot profile, not the
 *  Claude sub" holds regardless of whose model is being served. An id
 *  that already carries its own `@route` suffix (`resolved.directRoute !==
 *  resolved.vendor`) is equally a router path even with no adapter mode. */
function isDirectRoute(mode: string | undefined, resolved: ResolvedModel): boolean {
  return mode === undefined && resolved.directRoute === resolved.vendor
}

interface RouteContribution {
  vendor: string
  product: string
  route: string
  ref: string
  baseUrl: string | null
  pricing: CatalogPricing | null
  curated: boolean
  adapterSlug?: string
  adapterMode?: string
  methods: readonly AuthMethod[]
}

/** Curated contributions — one per adapter-declared model entry. */
function curatedContributions(
  adapters: readonly CatalogAdapterInput[],
): RouteContribution[] {
  const out: RouteContribution[] = []
  for (const adapter of adapters) {
    for (const model of adapter.models) {
      const resolved = resolveModelId(model.id)
      const route = model.mode ?? resolved.directRoute
      const methods: AuthMethod[] = isDirectRoute(model.mode, resolved)
        ? methodsForDirect(adapter.authDescriptor)
        : ["api-key"]
      out.push({
        vendor: resolved.vendor,
        product: resolved.product,
        route,
        ref: resolved.ref,
        baseUrl: resolved.baseUrl,
        pricing: resolved.pricing,
        curated: true,
        adapterSlug: adapter.slug,
        ...(model.mode ? { adapterMode: model.mode } : {}),
        methods,
      })
    }
  }
  return out
}

/** Widen beyond every adapter's declared list (SPEC §5.1): for each
 *  distinct (vendor, product) already known from a curated contribution,
 *  probe the router routes route-identity knows about and add a
 *  non-curated contribution for any that resolve and aren't already
 *  covered by a curated row. */
function widenedContributions(
  curated: readonly RouteContribution[],
): RouteContribution[] {
  const seenProducts = new Map<string, Set<string>>() // "vendor/product" -> routes already present
  for (const c of curated) {
    const key = `${c.vendor}/${c.product}`
    const routes = seenProducts.get(key) ?? new Set<string>()
    routes.add(c.route)
    seenProducts.set(key, routes)
  }

  const out: RouteContribution[] = []
  for (const [key, existingRoutes] of seenProducts) {
    const [vendor, product] = key.split("/", 2) as [string, string]
    for (const router of WIDENING_ROUTES) {
      if (existingRoutes.has(router)) continue
      const resolved = resolveLlmModelRoute(`${vendor}/${product}@${router}`)
      if (!resolved) continue
      out.push({
        vendor,
        product,
        route: router,
        ref: formatModelRef(resolved.ref),
        baseUrl: resolved.transport.baseUrl ?? null,
        pricing: {
          inPer1M: resolved.pricing.inputPer1M,
          outPer1M: resolved.pricing.outputPer1M,
        },
        curated: false,
        methods: ["api-key"],
      })
    }
  }
  return out
}

interface MergedRow {
  vendor: string
  product: string
  route: string
  ref: string
  baseUrl: string | null
  pricing: CatalogPricing | null
  curated: boolean
  adapters: string[]
  adapterModes: string[]
  methods: AuthMethod[]
}

/** Merge contributions sharing a (vendor, product, route) key — multiple
 *  adapters can curate the same route, and a widened route always merges
 *  into whichever curated row already claimed it. */
function mergeContributions(
  contributions: readonly RouteContribution[],
): MergedRow[] {
  const rows = new Map<string, MergedRow>()
  for (const c of contributions) {
    const key = `${c.vendor} ${c.product} ${c.route}`
    const existing = rows.get(key)
    if (!existing) {
      rows.set(key, {
        vendor: c.vendor,
        product: c.product,
        route: c.route,
        ref: c.ref,
        baseUrl: c.baseUrl,
        pricing: c.pricing,
        curated: c.curated,
        adapters: c.adapterSlug ? [c.adapterSlug] : [],
        adapterModes: c.adapterMode ? [c.adapterMode] : [],
        methods: [...c.methods],
      })
      continue
    }
    existing.curated = existing.curated || c.curated
    existing.baseUrl = existing.baseUrl ?? c.baseUrl
    existing.pricing = existing.pricing ?? c.pricing
    if (c.adapterSlug && !existing.adapters.includes(c.adapterSlug)) {
      existing.adapters.push(c.adapterSlug)
    }
    if (c.adapterMode && !existing.adapterModes.includes(c.adapterMode)) {
      existing.adapterModes.push(c.adapterMode)
    }
    for (const m of c.methods) {
      if (!existing.methods.includes(m)) existing.methods.push(m)
    }
  }
  return [...rows.values()]
}

/** The billed vendor for a (vendor, route) pair — the model's own vendor on
 *  its direct route, else the route's own id (SPEC §1c). */
function billedVendor(vendor: string, route: string): string {
  return route === vendor ? vendor : route
}

/** The pure join (SPEC §5): adapter-declared models + router widening +
 *  the #470 eligibility predicate → the vendor/product/route tree. No I/O —
 *  callers (the HTTP route / MCP tool) own loading adapters + profiles. */
export function buildCatalogModels(
  input: BuildCatalogModelsInput,
): CatalogModelsResponse {
  const contributions = [
    ...curatedContributions(input.adapters),
    ...widenedContributions(curatedContributions(input.adapters)),
  ]
  const merged = mergeContributions(contributions)
  const query = input.query ?? {}

  const vendors = new Map<string, Map<string, CatalogRoute[]>>()
  for (const row of merged) {
    if (query.vendor && row.vendor !== query.vendor) continue
    if (query.route && row.route !== query.route) continue
    if (query.adapter && !row.adapters.includes(query.adapter)) continue

    const manifest: AdapterAuthManifest = {
      id: `${row.vendor}/${row.product}@${row.route}`,
      vendorByRoute: { [row.route]: billedVendor(row.vendor, row.route) },
      methodsByRoute: { [row.route]: row.methods },
    }
    const eligible = eligibleProfiles(input.profiles, manifest, row.route)
    const runnable = eligible.length > 0
    if (query.runnableOnly && !runnable) continue

    const route: CatalogRoute = {
      route: row.route,
      ref: row.ref,
      baseUrl: row.baseUrl,
      pricing: row.pricing,
      runnable,
      eligibleProfiles: eligible.map(p => p.id),
      adapterModes: row.adapterModes,
      adapters: row.adapters,
      curated: row.curated,
    }

    const products = vendors.get(row.vendor) ?? new Map<string, CatalogRoute[]>()
    vendors.set(row.vendor, products)
    const routes = products.get(row.product) ?? []
    products.set(row.product, routes)
    routes.push(route)
  }

  const result: CatalogVendor[] = [...vendors.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([vendor, products]) => ({
      vendor,
      products: [...products.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([product, routes]) => ({
          product,
          routes: [...routes].sort((a, b) => a.route.localeCompare(b.route)),
        })),
    }))

  return { vendors: result }
}
