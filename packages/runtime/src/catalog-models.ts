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
import {
  getModelProvider,
  resolvePricingExact,
  LLM_PRICING_CATALOG,
  MODEL_ALIASES,
} from "@agentproto/model-catalog/llm"
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
  /**
   * True when MORE THAN ONE distinct model is servable on this route across
   * the whole catalog join (AIP-45 launch-menu drill-down, SPEC §3/§5.3).
   * Derived from the model×route join, never a hand-maintained table:
   * `anthropic`/`openrouter`/`llm-endpoint` serve many models (`true`),
   * a single-model gateway like `moonshot` serves one (`false`). A
   * single-model route pins every model tier to its one model downstream,
   * and gates the custom-gateway A-vs-B promotion (SPEC D5). Independent of
   * the caller's query filters — this is the route's intrinsic capacity, so
   * the same route reports the same `multiModel` in a filtered response.
   */
  multiModel: boolean
}

/**
 * One route's servable-model index (SPEC §3.9) — the flat, per-route view
 * that lets a capability-derived UI derive tier pinning without re-walking
 * the vendor/product tree. `servableModels` is the set of `vendor/product`
 * model identities reachable on this route across the whole join;
 * `multiModel` is `servableModels.length > 1` (the same value carried on
 * every {@link CatalogRoute} with this id). Always the full, unfiltered
 * catalog capacity, independent of the query — a route's model-count is
 * intrinsic, not a view of the filtered result.
 */
export interface CatalogRouteSummary {
  route: string
  servableModels: string[]
  multiModel: boolean
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
  /**
   * Flat servable-models-per-route index (SPEC §3.9), one entry per distinct
   * route id in the catalog, sorted by route. Exposes the same join the
   * nested `multiModel` flags derive from, so a capability layer can compute
   * tier pinning per route without re-walking the vendor tree. Always the
   * full, unfiltered catalog capacity (see {@link CatalogRouteSummary}).
   */
  routes: CatalogRouteSummary[]
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

/**
 * Per-model curation gate (WS3): does `profile`'s allowlist admit this model?
 * An ABSENT `models` field, or `mode: "all"`, admits everything — the exact
 * pre-curation behavior, so a profile that predates the field is unchanged
 * (the byte-identical invariant). A `mode: "allow"` profile admits the model
 * only when its catalog identity is in the list — matched against BOTH the
 * route-qualified `ref` (`z-ai/glm-5.2@openrouter`) and the route-independent
 * `vendor/product` (`z-ai/glm-5.2`), so a curated id in either form is honored.
 * It ALSO honors the BARE product (`claude-opus-4-8` — everything after the
 * first `/` of `vendorProduct`), but ONLY on a DIRECT route (a `ref` with no
 * `@route` suffix). The vscode "+ Models" picker writes bare pricing-catalog
 * ids verbatim into an allowlist for single-vendor DIRECT endpoints (anthropic,
 * moonshot, …), and every existing user allowlist for those is in that form, so
 * the bare tolerance keeps them working with zero migration. It is deliberately
 * NOT extended to multi-vendor GATEWAY endpoints (openrouter/requesty host the
 * same bare product under many vendor prefixes — `sference/glm-5.2` and
 * `z-ai/glm-5.2` are distinct rows on the same endpoint), where a bare id would
 * over-widen across sibling vendors. For those the `ref` (`z-ai/glm-5.2@openrouter`)
 * or the `vendor/product` form (`z-ai/glm-5.2`) is required — which is exactly
 * what the picker writes for gateway endpoints anyway.
 * This is deliberately downstream of `eligibleProfiles` (the endpoint/method
 * gate): a curated profile stays endpoint-eligible but services only its
 * chosen model refs.
 */
function profileAllowsModel(profile: AuthProfile, ref: string, vendorProduct: string): boolean {
  const curation = profile.models
  if (!curation || curation.mode === "all") return true
  // The bare product is everything after the FIRST `/` (the vendor is always
  // the first segment; the product may itself contain `/`). No slash → treat
  // the whole string as the product.
  const slash = vendorProduct.indexOf("/")
  const product = slash === -1 ? vendorProduct : vendorProduct.slice(slash + 1)
  // A gateway/router route carries an `@route` suffix in its ref
  // (`z-ai/glm-5.2@openrouter`); a direct route ref is bare `vendor/product`.
  // Bare-product tolerance is DIRECT-only — on a multi-vendor gateway a bare id
  // would admit every sibling vendor's same-named product.
  const isDirect = !ref.includes("@")
  return (
    curation.ids.includes(ref) ||
    curation.ids.includes(vendorProduct) ||
    (isDirect && curation.ids.includes(product))
  )
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

  // Servable-models-per-route (SPEC §3.9), over the FULL join — a route's
  // model-count is an intrinsic capability, not a view of the caller's
  // query, so `multiModel` stays stable under filtering. A model identity is
  // its `vendor/product` (the same key `widenedContributions` dedupes on), so
  // the same product served by several adapters counts once.
  const servableByRoute = new Map<string, Set<string>>()
  for (const row of merged) {
    const set = servableByRoute.get(row.route) ?? new Set<string>()
    set.add(`${row.vendor}/${row.product}`)
    servableByRoute.set(row.route, set)
  }
  const isMultiModel = (route: string): boolean =>
    (servableByRoute.get(route)?.size ?? 0) > 1

  const vendors = new Map<string, Map<string, CatalogRoute[]>>()
  for (const row of merged) {
    if (query.vendor && row.vendor !== query.vendor) continue
    if (query.route && row.route !== query.route) continue
    if (query.adapter && !row.adapters.includes(query.adapter)) continue

    // Per-model wallet-serviceability gate (SPEC §1c parity with the spawn
    // guard, `checkModelWalletEligibility` / session-spawn.ts:1143): a DIRECT
    // vendor route — `row.route === row.vendor` with no adapter-mode override
    // in play (`row.adapterModes.length === 0`; an override can coincidentally
    // route === vendor, e.g. a `moonshot` mode reached serving a moonshot-
    // vendor model — see `isDirectRoute`'s own doc comment) — is the catalog's
    // equivalent of spawning with no `route.gateway` named: the adapter's
    // fixed wallet is billed, and that wallet might not actually service this
    // specific model (`claude-fable-5` bills `openrouter`/`requesty`, never
    // `anthropic`, even though the `claude-code` adapter curates it). Reuses
    // the SAME predicate the spawn guard uses — no parallel per-model table.
    // A gateway/mode/router route is the catalog's equivalent of an EXPLICIT
    // `route.gateway` — the spawn guard deliberately never second-guesses
    // that (routing any model through any named gateway's api-key is
    // legitimate), so it is left ungated here too.
    const isDirectVendorRoute = row.route === row.vendor && row.adapterModes.length === 0
    const walletEligible =
      !isDirectVendorRoute ||
      checkModelWalletEligibility(`${row.vendor}/${row.product}`, row.route).ok

    const manifest: AdapterAuthManifest = {
      id: `${row.vendor}/${row.product}@${row.route}`,
      endpointByRoute: { [row.route]: billedVendor(row.vendor, row.route) },
      methodsByRoute: { [row.route]: row.methods },
    }
    // The endpoint/method-eligible profiles for this route (whole-profile
    // enable/disable already applied inside `eligibleProfiles`), then narrowed
    // by each profile's per-model curation allowlist (WS3). A profile with no
    // `models` field passes through untouched, so the non-curated join is
    // byte-identical to before.
    const eligible = walletEligible
      ? eligibleProfiles(input.profiles, manifest, row.route).filter(p =>
          profileAllowsModel(p, row.ref, `${row.vendor}/${row.product}`),
        )
      : []
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
      multiModel: isMultiModel(row.route),
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

  const routes: CatalogRouteSummary[] = [...servableByRoute.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([route, models]) => ({
      route,
      servableModels: [...models].sort((a, b) => a.localeCompare(b)),
      multiModel: models.size > 1,
    }))

  return { vendors: result, routes }
}

/**
 * The billing routes that can service `model`, reusing the SAME route-identity
 * resolution this module's catalog join uses (SPEC §1c serviceability) — never
 * a parallel per-model provider table. A route R services the model iff:
 *   - R is the model's catalog billing provider (`getModelProvider` — the native
 *     vendor SDK for a bare/direct id, or the router for a gateway-only slash id
 *     like `deepseek/deepseek-v4-pro` ⇒ `openrouter`),
 *   - R is an explicit `@route` carried in the id (`…@openrouter`), or
 *   - the model resolves on R as one of the {@link WIDENING_ROUTES} router routes
 *     (catches requesty-only ids like `sference/…` that carry no pricing-catalog
 *     `provider` for `getModelProvider` to return).
 *
 * Returns the DISTINCT serviceable routes; EMPTY when the model is unknown to
 * the catalog — a mismatch cannot then be positively proven, so a money-safety
 * caller MUST NOT reject on an empty result (only on a non-empty set that
 * excludes the resolved wallet). See {@link checkModelWalletEligibility}.
 */
export function serviceableModelRoutes(model: string): string[] {
  const routes = new Set<string>()
  const provider = getModelProvider(model)
  if (provider) routes.add(provider)
  const parsed = tryParseModelRef(normalizeRouterPrefixedId(model))
  if (parsed) {
    // An explicit `@route` in the id is itself a serviceable route (and keeps
    // the `getModelProvider` quirk on `<vendor>/<product>@<router>` forms from
    // hiding the route the operator literally named).
    if (parsed.route !== parsed.vendor) routes.add(parsed.route)
    // A first-party vendor model whose `<vendor>/<product>` form COLLIDES with a
    // router-namespaced pricing key hides its own direct vendor route: OpenRouter
    // keys e.g. `anthropic/claude-sonnet-5` / `anthropic/claude-fable-5` with the
    // SAME dash spelling Anthropic uses, tagged `provider:"openrouter"`, so
    // `getModelProvider("anthropic/claude-sonnet-5")` resolves to the ROUTER and
    // `anthropic` never enters `routes` above. Restore it: when the BARE product
    // is itself a first-party model of this vendor — a VERBATIM first-party
    // pricing key (`resolvePricingExact(product).provider === vendor`) — the
    // vendor's own SDK/wallet can bill it, so the direct vendor route genuinely
    // IS serviceable. This MUST be the exact lookup, never `resolvePricing`'s
    // substring fallback: an openrouter-only sibling variant like
    // `google/gemini-2.5-flash-image` substring-hits the unrelated
    // `gemini-2.5-flash` row (provider `google`) and would spuriously earn a
    // `google` direct route it cannot actually be billed on. A gateway-only
    // slash id (`deepseek/deepseek-v4-pro` — no bare first-party pricing row)
    // likewise yields no exact match and is left untouched, preserving the
    // money-safety guard's reject on a true router-only model. Scoped to this
    // function: `resolvePricingExact`/`getModelProvider` semantics are unchanged
    // for every other caller.
    if (resolvePricingExact(parsed.product)?.provider === parsed.vendor) {
      routes.add(parsed.vendor)
    }
    for (const router of WIDENING_ROUTES) {
      if (tryResolveLlmModelRoute(`${parsed.vendor}/${parsed.product}@${router}`)) {
        routes.add(router)
      }
    }
  }
  return [...routes]
}

/** The bare product of a model id — the segment after the last `/`, stripped
 *  of any `@route` / `:pin` suffix, lower-cased. `deepseek/deepseek-chat` →
 *  `deepseek-chat`; `z-ai/glm-5.2@openrouter` → `glm-5.2`; `claude-opus-4-8`
 *  (no slash) → `claude-opus-4-8`. This is the identity the "did you mean"
 *  matcher keys on, so a wrong-or-missing vendor/route prefix collapses onto
 *  the same product. */
function bareProduct(id: string): string {
  const noSuffix = id.split("@")[0]!.split(":")[0]!
  const slash = noSuffix.lastIndexOf("/")
  return (slash === -1 ? noSuffix : noSuffix.slice(slash + 1)).toLowerCase()
}

/**
 * Closest known catalog model ids for a slug UNKNOWN to the local catalog —
 * the "did you mean" set behind the spawn-time model advisory (session-spawn.ts).
 *
 * Deliberately narrow to keep false positives near zero: a known id qualifies
 * ONLY when its {@link bareProduct} equals the input's while the full id
 * differs — i.e. the caller used the wrong-or-missing vendor/route prefix
 * (`deepseek-chat` → `deepseek/deepseek-chat`, `glm-5.2` → `z-ai/glm-5.2`,
 * `moonshot/kimi-k2` → `moonshotai/kimi-k2`). A genuinely-new model on a known
 * vendor (`qwen/qwen4-max` when only `qwen3-max` is catalogued) shares no bare
 * product and yields nothing — so a new / free-form slug never earns a spurious
 * suggestion, matching the money-safety guard's own never-reject-an-unknown-
 * model rule. Sourced from the catalog itself (`LLM_PRICING_CATALOG` +
 * `MODEL_ALIASES` keys), never a hand-maintained second list.
 */
export function suggestModelSlugs(model: string): string[] {
  const target = bareProduct(model)
  if (!target) return []
  const out = new Set<string>()
  for (const id of [...Object.keys(LLM_PRICING_CATALOG), ...Object.keys(MODEL_ALIASES)]) {
    if (id !== model && bareProduct(id) === target) out.add(id)
  }
  return [...out].sort().slice(0, 5)
}

/** Verdict of the spawn-time money-safety guard ({@link checkModelWalletEligibility}). */
export interface ModelWalletEligibility {
  ok: boolean
  /** Serviceable routes for the model that DIFFER from the resolved wallet —
   *  the actionable set to re-spawn onto. Empty when `ok`. */
  suggestedRoutes: string[]
}

/**
 * Money-safety spawn guard (SPEC §1c): can the resolved billing wallet
 * `walletRoute` (the gateway id when a `route.gateway` is set, else the resolved
 * billing provider) service `model`? Reuses {@link serviceableModelRoutes} — no
 * parallel table. Returns `ok:true` when the model is serviceable on the wallet,
 * OR when the model is unknown to the catalog (empty serviceable set — a mismatch
 * cannot be positively proven, so the guard must not reject a possibly-legitimate
 * new model). Returns `ok:false` with the serviceable alternative routes ONLY
 * when the model IS serviceable on some route but NOT the resolved wallet — the
 * exact 404-upstream case (`deepseek/deepseek-v4-pro` on the Anthropic sub). The
 * guard only REJECTS; it never substitutes a wallet the operator didn't name.
 */
export function checkModelWalletEligibility(
  model: string,
  walletRoute: string,
): ModelWalletEligibility {
  const serviceable = serviceableModelRoutes(model)
  if (serviceable.length === 0 || serviceable.includes(walletRoute)) {
    return { ok: true, suggestedRoutes: [] }
  }
  return { ok: false, suggestedRoutes: serviceable.filter(r => r !== walletRoute) }
}

/**
 * The actionable fail-fast message shared by both spawn paths (session-spawn +
 * session-restart-core) so they never drift. Names the wallet that couldn't
 * service the model AND the required route + api-key profile to re-spawn onto —
 * never a wallet the guard picked for the operator.
 */
export function modelWalletIneligibleMessage(opts: {
  prefix: string
  adapter: string
  model: string
  walletRoute: string
  walletMode?: "subscription" | "api-key"
  suggestedRoutes: string[]
}): string {
  const wallet = opts.walletMode
    ? `"${opts.walletRoute}" ${opts.walletMode} wallet`
    : `"${opts.walletRoute}" wallet`
  const primary = opts.suggestedRoutes[0] ?? "a gateway route"
  const also =
    opts.suggestedRoutes.length > 1
      ? ` (also serviceable via ${opts.suggestedRoutes
          .slice(1)
          .map(r => `"${r}"`)
          .join(", ")})`
      : ""
  return (
    `${opts.prefix}: model "${opts.model}" is not serviceable on the resolved ${wallet} ` +
    `(adapter "${opts.adapter}") and would 404 upstream. This model bills route "${primary}"${also} — ` +
    `re-spawn on it: set route.gateway="${primary}" with an eligible "${primary}" api-key profile ` +
    `(access.profileRef). This guard only rejects; it never switches wallets for you.`
  )
}
