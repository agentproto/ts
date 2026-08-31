/**
 * Read-only per-provider model enumeration (AIP-45 launch-menu "+" picker,
 * phase 1) — the EXHAUSTIVE list of every model a single provider can serve.
 *
 * Deliberately separate from the spawn-facing `catalog_models` join
 * (`catalog-models.ts`). That tool answers "what is spawnable given this
 * host's adapters + auth profiles", and stays lean on purpose — it only
 * widens the curated (vendor, product) pairs through the router routes. This
 * tool answers the orthogonal, spawn-agnostic question "everything <provider>
 * offers", the full set the "+" picker browses before any adapter/profile is
 * chosen. Keeping the two apart is what lets the spawn catalog stay small
 * while the picker still sees the whole provider surface.
 *
 * Backed straight by the static catalog's `getModelsByProvider`
 * (`@agentproto/model-catalog`, `registry/index.ts`) — a pure query over the
 * kind-organized catalogs, so NO adapters, NO profiles, NO host wiring.
 * `getModelsByProvider` is itself router-aware: OpenRouter's route table is
 * spread into `LLM_PRICING_CATALOG` upstream (`llm/catalog.ts`), so an
 * `openrouter` query returns that full, large list with bare ids; Requesty
 * and HuggingFace are NOT spread into that catalog — spreading a second
 * router's bare-id pricing there would repoint direct-vendor ids at router
 * pricing (`route-identity/index.ts`) — so `getModelsByProvider` instead
 * folds their generated route tables in directly, emitting `vendor/
 * product@route` ids. All three routers enumerate through the same path;
 * the picker paginates client-side. NEVER log the rows: OpenRouter alone is
 * thousands.
 */

import {
  getModelsByProvider,
  getStaticModelProvider,
  type ResolvedModel,
} from "@agentproto/model-catalog"

export interface CatalogProviderModelsQuery {
  /** Provider / billing endpoint to enumerate (anthropic, openai, openrouter,
   *  replicate, minimax, …). `route` is an accepted synonym — the picker
   *  keys on a route id, an operator on an endpoint, and both mean the same
   *  provider key here. An unknown or empty provider yields `models: []`. */
  endpoint?: string
  /** Synonym for `endpoint` (takes precedence when both are given). */
  route?: string
}

/** Per-1M-token USD pricing, mirroring `catalog-models.ts`'s `CatalogPricing`. */
export interface CatalogProviderPricing {
  inPer1M: number
  outPer1M: number
}

/** One servable model in a provider's enumeration. */
export interface CatalogProviderModel {
  /** The model id exactly as the caller would spawn/select it. */
  id: string
  /** llm / image / video / audio / voice. */
  kind: ResolvedModel["kind"]
  /** User-facing name where the catalog carries one (image/video/audio
   *  `name`, voice `label`); falls back to the canonical id for LLM entries,
   *  which have no display name in the catalog. */
  label: string
  /** The provider/route this model is served on — the LLM pricing provider
   *  (== the queried provider) for LLM, the statically-pinned adapter
   *  platform for the media kinds. `null` when the catalog carries none. */
  route: string | null
  /** Per-1M-token pricing for LLM models; `null` for the media kinds, whose
   *  pricing is per-image/second/character rather than per token. */
  pricing: CatalogProviderPricing | null
  /** ISO date (`YYYY-MM-DD`) this model first appeared in the catalog, when
   *  known — see `LLMPricing.addedAt` (`model-catalog/src/llm/catalog.ts`)
   *  for the convention. `null` for media kinds and for LLM entries the sync
   *  never stamped (hand-maintained rows). Lets a picker show a "new" badge. */
  addedAt: string | null
}

export interface CatalogProviderModelsResponse {
  /** The provider key that was enumerated (echoed back, trimmed). */
  provider: string
  models: CatalogProviderModel[]
}

/** User-facing name per kind — the catalog carries `name` on the media model
 *  defs and `label` on voices, but LLM entries have neither, so the canonical
 *  id is the best label available there. */
function labelOf(model: ResolvedModel): string {
  switch (model.kind) {
    case "image":
    case "video":
    case "audio":
      return model.def.name
    case "voice":
      return model.voice.label
    case "llm":
      return model.canonicalId
  }
}

/** The provider/route a model is served on. LLM routing is decided at call
 *  time so `getStaticModelProvider` returns undefined for it — the pricing
 *  provider (which IS the queried provider on this per-provider query) is the
 *  meaningful value; the media kinds are statically pinned to their adapter. */
function routeOf(model: ResolvedModel): string | null {
  // `model.provider` (not `model.pricing?.provider`) so a known-but-not-
  // yet-priced id (pricing undefined — see ResolvedModel's doc comment)
  // still reports its provider, derived from CONTEXT_WINDOWS by `getModel`.
  if (model.kind === "llm") return model.provider ?? null
  return getStaticModelProvider(model) ?? null
}

function pricingOf(model: ResolvedModel): CatalogProviderPricing | null {
  if (model.kind !== "llm" || !model.pricing) return null
  return { inPer1M: model.pricing.inputPer1M, outPer1M: model.pricing.outputPer1M }
}

function addedAtOf(model: ResolvedModel): string | null {
  if (model.kind !== "llm" || !model.pricing) return null
  return model.pricing.addedAt ?? null
}

/**
 * The pure per-provider enumeration behind the `catalog_provider_models` MCP
 * tool. No I/O, no host state — just a projection over the static catalog.
 * An unknown or empty provider returns an empty list rather than throwing:
 * "this provider serves nothing here" is a valid answer, not an error, so the
 * picker can query any provider key without a guard.
 */
export function buildCatalogProviderModels(
  query: CatalogProviderModelsQuery = {},
): CatalogProviderModelsResponse {
  const provider = (query.route ?? query.endpoint ?? "").trim()
  if (!provider) return { provider: "", models: [] }
  const models = getModelsByProvider(provider).map<CatalogProviderModel>(m => ({
    id: m.id,
    kind: m.kind,
    label: labelOf(m),
    route: routeOf(m),
    pricing: pricingOf(m),
    addedAt: addedAtOf(m),
  }))
  return { provider, models }
}
