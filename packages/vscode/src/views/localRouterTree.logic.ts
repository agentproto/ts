/**
 * Pure tree-building logic for the "Local Router" grouping in the auth
 * profiles view — the daemon-supervised `@agentproto/llm-endpoint` proxy
 * sidecar. No vscode import so it's unit-testable under plain vitest, mirroring
 * authProfilesTree.logic.ts.
 *
 * The Local Router is a single top-level node (a sibling of the Provider
 * Presets / Model Profiles groupings) that renders the proxy's lifecycle
 * status + start/stop affordances, and — when running & healthy — expands to
 * the models it currently serves (fetched live from its `/v1/models`) with
 * catalog pricing cross-referenced for display.
 */

import type {
  CatalogModelsResponse,
  CatalogPricing,
  LlmEndpointStatusResult,
} from "../client/types.js"

export type { LlmEndpointStatusResult }

/** One model the proxy currently serves, parsed from its `/v1/models`. */
export interface DiscoveredModel {
  id: string
  /** OpenAI-style `owned_by`, or the anthropic-style `display_name` fallback. */
  ownedBy?: string
}

/** One pack the proxy exposes, parsed from its `GET /v1/packs`. */
export interface RouterPack {
  id: string
  /** The pack's human label, when the proxy reports one. */
  label?: string
  /** How many model routes the pack carries (the proxy's `model_count`). */
  modelCount: number
}

export type LocalRouterNode =
  | { kind: "router" }
  | { kind: "router-packs" }
  | { kind: "router-pack"; pack: RouterPack }
  | { kind: "router-model"; model: DiscoveredModel }
  | { kind: "router-message"; message: string }

export type LocalRouterTreeNode = LocalRouterNode

export function isLocalRouterNode(node: { kind: string }): node is LocalRouterNode {
  return (
    node.kind === "router" ||
    node.kind === "router-packs" ||
    node.kind === "router-pack" ||
    node.kind === "router-model" ||
    node.kind === "router-message"
  )
}

/** True while the endpoint has (or is bringing up) a live child — the states
 *  that offer a "Stop" action and can be probed for models. */
export function routerRunning(status: LlmEndpointStatusResult | null): boolean {
  if (!status) return false
  return status.status === "running" || status.status === "starting"
}

/** True only when the child is up AND its live `/v1/models` probe passed —
 *  the one state where the discovered-models children are worth fetching. */
export function routerServing(status: LlmEndpointStatusResult | null): boolean {
  return routerRunning(status) && !!status?.healthy
}

/** The Local Router row label: `Local Router — running :18090` while up,
 *  `Local Router — starting :18090` mid-boot, `Local Router — stopped`
 *  otherwise. The port is only meaningful once a child owns it. */
export function routerLabel(status: LlmEndpointStatusResult | null): string {
  if (!status) return "Local Router — stopped"
  const state =
    status.status === "never-started" ? "stopped" : status.status
  if (routerRunning(status) && typeof status.port === "number") {
    return `Local Router — ${state} :${status.port}`
  }
  return `Local Router — ${state}`
}

/** A short description tail, leading with health so a running-but-unhealthy
 *  proxy is visible at a glance rather than buried in the tooltip. */
export function routerDescription(status: LlmEndpointStatusResult | null): string {
  if (!routerRunning(status)) return ""
  return status?.healthy ? "healthy" : "unhealthy"
}

/**
 * Codicon id for the Local Router row, mirroring servicedModelIcon's style:
 * running & healthy → `pass` (green check), starting or running-but-unhealthy
 * → `sync` (spinner), a hard error → `error`, stopped/never-started →
 * `circle-slash`.
 */
export function routerIcon(status: LlmEndpointStatusResult | null): string {
  if (!status) return "circle-slash"
  if (status.status === "error") return "error"
  if (status.status === "starting") return "sync"
  if (status.status === "running") return status.healthy ? "pass" : "sync"
  return "circle-slash"
}

/** The context value driving the start/stop menu split: a running (or
 *  starting) endpoint offers "Stop", everything else offers "Start". */
export function routerContextValue(status: LlmEndpointStatusResult | null): string {
  return routerRunning(status) ? "local-router-running" : "local-router-stopped"
}

/** The Local Router row's rich tooltip: state, pid, base URL, start time, any
 *  last error, and the providers whose keys were injected into the child. */
export function routerTooltip(status: LlmEndpointStatusResult | null): string {
  const lines = ["**Local Router**", ""]
  if (!status) {
    lines.push("- Status: stopped")
    return lines.join("\n")
  }
  lines.push(`- Status: ${status.status}`)
  lines.push(`- Healthy: ${status.healthy ? "yes" : "no"}`)
  if (typeof status.pid === "number") lines.push(`- PID: ${status.pid}`)
  if (typeof status.port === "number") lines.push(`- Port: ${status.port}`)
  if (status.baseUrl) lines.push(`- Base URL: ${status.baseUrl}`)
  if (status.startedAt) lines.push(`- Started: ${status.startedAt}`)
  if (status.injectedProviders && status.injectedProviders.length > 0) {
    lines.push(`- Providers: ${status.injectedProviders.join(", ")}`)
  }
  if (status.lastError) lines.push(`- Last error: ${status.lastError}`)
  return lines.join("\n")
}

/** The base URL to probe for `/v1/models`: the status `baseUrl` when the
 *  daemon reports one, else synthesized from the port on loopback. Returns
 *  undefined when neither is known (so the caller skips the fetch). */
export function routerBaseUrl(status: LlmEndpointStatusResult | null): string | undefined {
  if (!status) return undefined
  if (status.baseUrl) return status.baseUrl.replace(/\/+$/, "")
  if (typeof status.port === "number") return `http://localhost:${status.port}`
  return undefined
}

/**
 * Parse an OpenAI-style `/v1/models` body into discovered models. Tolerates
 * both the OpenAI shape (`{data:[{id, owned_by}]}`) and the anthropic-style
 * one (`{data:[{id, display_name}]}`), and ignores rows without a string id.
 */
export function parseDiscoveredModels(body: unknown): DiscoveredModel[] {
  const data = (body as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  const models: DiscoveredModel[] = []
  for (const row of data) {
    if (!row || typeof row !== "object") continue
    const rec = row as Record<string, unknown>
    const id = rec.id
    if (typeof id !== "string" || !id) continue
    const ownedBy =
      typeof rec.owned_by === "string" && rec.owned_by
        ? rec.owned_by
        : typeof rec.display_name === "string" && rec.display_name
          ? rec.display_name
          : undefined
    models.push(ownedBy ? { id, ownedBy } : { id })
  }
  return models
}

/**
 * Catalog pricing cross-reference. `byKey` maps every id a discovered model
 * might carry (route `ref`, `vendor/product`, bare `product`) to a price;
 * `productVendors` records, per bare product, the set of catalog vendors that
 * carry it WITH a price — the disambiguation `lookupModelPricing` needs so a
 * bare-product key that straddles two vendors is never attributed to the wrong
 * one.
 */
export interface CatalogPricingIndex {
  byKey: Map<string, CatalogPricing>
  productVendors: Map<string, Set<string>>
}

/**
 * Map a discovered model's `owned_by` (the resolved upstream provider, as the
 * proxy reports it — e.g. `zai`, `xai`, `moonshot`) onto the catalog's vendor
 * id (`z-ai`, `x-ai`, …) so a vendor-scoped pricing lookup can match. A small
 * explicit table with identity fallback — an unknown owner is used as-is
 * (lower-cased) rather than guessed at.
 */
const PROXY_VENDOR_ALIASES: Record<string, string> = {
  zai: "z-ai",
  xai: "x-ai",
  moonshot: "moonshot",
  moonshotai: "moonshotai",
  groq: "groq",
  openrouter: "openrouter",
  requesty: "requesty",
  openai: "openai",
  anthropic: "anthropic",
}

/** Normalize a proxy-reported `owned_by` to the catalog's vendor id. */
export function normalizeOwnedByVendor(ownedBy: string): string {
  const key = ownedBy.toLowerCase()
  return PROXY_VENDOR_ALIASES[key] ?? key
}

/** An empty index — the initial/reset state before a catalog is loaded. */
export function emptyPricingIndex(): CatalogPricingIndex {
  return { byKey: new Map(), productVendors: new Map() }
}

/**
 * Index the catalog's per-route pricing by every id a discovered model might
 * carry: the route `ref` (e.g. `anthropic/claude-fable-5`), the
 * `vendor/product` pair, and the bare product name. First price wins per key —
 * the catalog walk order (vendor → product → route) is deterministic. Also
 * records which vendors carry each bare product (with a price) so a same-named
 * product served under two routes/vendors can be disambiguated at lookup.
 */
export function buildCatalogPricingIndex(
  catalog: CatalogModelsResponse,
): CatalogPricingIndex {
  const byKey = new Map<string, CatalogPricing>()
  const productVendors = new Map<string, Set<string>>()
  for (const vendor of catalog.vendors ?? []) {
    for (const product of vendor.products ?? []) {
      for (const route of product.routes ?? []) {
        if (!route.pricing) continue
        const keys = [route.ref, `${vendor.vendor}/${product.product}`, product.product]
        for (const key of keys) {
          if (key && !byKey.has(key)) byKey.set(key, route.pricing)
        }
        if (product.product) {
          let vendors = productVendors.get(product.product)
          if (!vendors) {
            vendors = new Set()
            productVendors.set(product.product, vendors)
          }
          vendors.add(vendor.vendor)
        }
      }
    }
  }
  return { byKey, productVendors }
}

/**
 * Look up a discovered model's price, PREFERRING a vendor-scoped match built
 * from its resolved upstream provider (`ownedBy`) so a natively-served product
 * never displays a same-named sibling route's (e.g. an OpenRouter snapshot's)
 * price. Order: `<normalizedVendor>/<id>` → a slash-qualified `id` (already a
 * ref / vendor·product) → the bare-product key last.
 *
 * The bare key is the ambiguous one: when the only match is bare AND the
 * catalog carries that product under MORE THAN ONE vendor (none of them
 * `ownedBy`), we return null ("no catalog pricing") rather than a price we
 * can't attribute to the owning provider — a missing price beats a misleading
 * one. A single-vendor product is unambiguous, so its price is returned even
 * when the `ownedBy` label doesn't map onto that vendor id.
 */
export function lookupModelPricing(
  index: CatalogPricingIndex,
  modelId: string,
  ownedBy?: string,
): CatalogPricing | null {
  // 1. Vendor-scoped preferred match from the resolved upstream provider.
  if (ownedBy) {
    const scoped = index.byKey.get(`${normalizeOwnedByVendor(ownedBy)}/${modelId}`)
    if (scoped) return scoped
  }
  // 2. A model id that is itself vendor-qualified (a ref or vendor/product) is
  //    unambiguous — a bare id must NOT match here, it falls through to (3).
  if (modelId.includes("/")) {
    const qualified = index.byKey.get(modelId)
    if (qualified) return qualified
  }
  // 3. Bare-product key, last — refused when it can't be attributed to ownedBy.
  const bare = index.byKey.get(modelId)
  if (!bare) return null
  if (ownedBy) {
    const vendors = index.productVendors.get(modelId)
    if (vendors && vendors.size > 1 && !vendors.has(normalizeOwnedByVendor(ownedBy))) {
      // Ambiguous: the product is priced under several vendors and none is the
      // owner — we can't pick the owner's price, so show none.
      return null
    }
  }
  return bare
}

/** Format a pricing pair as `$in/$out per 1M`, or the explicit
 *  no-pricing sentinel when the catalog carries none. */
export function formatPricing(pricing: CatalogPricing | null): string {
  if (!pricing) return "no catalog pricing"
  return `$${pricing.inPer1M}/$${pricing.outPer1M} per 1M`
}

/**
 * The description tail for a discovered-model leaf: `owned_by · $in/$out per 1M`
 * when the price is known, `owned_by · no catalog pricing` when it isn't, and
 * the pricing alone when the proxy reported no owner. The id is the label
 * (rendered by the view), so it's not repeated here.
 */
export function modelRowDescription(
  model: DiscoveredModel,
  pricing: CatalogPricing | null,
): string {
  const parts: string[] = []
  if (model.ownedBy) parts.push(model.ownedBy)
  parts.push(formatPricing(pricing))
  return parts.join(" · ")
}

/**
 * Build the Local Router's child rows from a `/v1/models` fetch outcome. A
 * successful fetch with models → one `router-model` per id (catalog pricing
 * cross-referenced); a healthy proxy that serves nothing → a single "no
 * models" message; a failed/unavailable fetch → an "unavailable" message.
 * Pure: the async fetch happens in the view, its resolved value flows in here.
 */
export function buildRouterModelChildren(
  models: DiscoveredModel[],
): LocalRouterNode[] {
  if (models.length === 0) {
    return [{ kind: "router-message", message: "No models served" }]
  }
  return models.map(model => ({ kind: "router-model", model }))
}

/** Fetches the proxy's live `/v1/models` — the injectable seam so tests never
 *  hit a real socket. Throws on a non-2xx / network failure so the tree can
 *  render an "unavailable" child instead of a silently-empty node. */
export type ModelsFetcher = (baseUrl: string) => Promise<DiscoveredModel[]>

/**
 * The Local Router's discovered-model children, resolved through the injected
 * `fetchModels` seam. Pure orchestration (no vscode), so it's testable without
 * a live socket — the view maps the returned nodes to TreeItems.
 *
 * - not serving → `[]` (the node isn't expandable, so this is unreachable in
 *   the view; guarded defensively).
 * - serving but no resolvable base URL → a single "Router address unavailable"
 *   message, NOT a silently-empty (yet expandable) node.
 * - fetch throws / times out → a single "Models unavailable" message.
 * - fetch succeeds → one `router-model` per id (or the "No models served"
 *   message when the proxy serves nothing).
 */
export async function resolveRouterModelChildren(
  status: LlmEndpointStatusResult | null,
  fetchModels: ModelsFetcher,
): Promise<LocalRouterNode[]> {
  if (!routerServing(status)) return []
  const baseUrl = routerBaseUrl(status)
  if (!baseUrl) {
    return [{ kind: "router-message", message: "Router address unavailable" }]
  }
  try {
    const models = await fetchModels(baseUrl)
    return buildRouterModelChildren(models)
  } catch {
    return [{ kind: "router-message", message: "Models unavailable" }]
  }
}

/**
 * Parse the proxy's `GET /v1/packs` body into router packs. Tolerates the
 * `{data:[{id, label, model_count, models:[…]}]}` shape, ignores rows without a
 * string id, and falls back to `models.length` when `model_count` is absent.
 * Mirrors parseDiscoveredModels' defensive style.
 */
export function parseRouterPacks(body: unknown): RouterPack[] {
  const data = (body as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  const packs: RouterPack[] = []
  for (const row of data) {
    if (!row || typeof row !== "object") continue
    const rec = row as Record<string, unknown>
    const id = rec.id
    if (typeof id !== "string" || !id) continue
    const label = typeof rec.label === "string" && rec.label ? rec.label : undefined
    const modelCount =
      typeof rec.model_count === "number" && Number.isFinite(rec.model_count)
        ? rec.model_count
        : Array.isArray(rec.models)
          ? rec.models.length
          : 0
    packs.push(label ? { id, label, modelCount } : { id, modelCount })
  }
  return packs
}

/** The description tail for a pack row: `<label> · N models`, or just
 *  `N models` when the proxy reported no label. */
export function routerPackDescription(pack: RouterPack): string {
  const count = `${pack.modelCount} model${pack.modelCount === 1 ? "" : "s"}`
  return pack.label ? `${pack.label} · ${count}` : count
}

/**
 * Build the Packs subtree's child rows from a `/v1/packs` fetch. A fetch with
 * packs → one `router-pack` per id; a proxy that exposes none → a single
 * "No packs" message. Pure: the async fetch happens in the view.
 */
export function buildRouterPackChildren(packs: RouterPack[]): LocalRouterNode[] {
  if (packs.length === 0) {
    return [{ kind: "router-message", message: "No packs" }]
  }
  return packs.map(pack => ({ kind: "router-pack", pack }))
}

/** Fetches the proxy's live `/v1/packs` — the injectable seam so tests never
 *  hit a real socket. Throws on a non-2xx / network failure so the subtree can
 *  render an "unavailable" child instead of a silently-empty node. */
export type PacksFetcher = (baseUrl: string) => Promise<RouterPack[]>

/**
 * The Packs subtree's children, resolved through the injected `fetchPacks`
 * seam. Pure orchestration (no vscode), so it's testable without a live socket.
 * Mirrors resolveRouterModelChildren:
 * - not serving → `[]` (the node isn't expandable, so unreachable in the view).
 * - serving but no resolvable base URL → a "Router address unavailable" message.
 * - fetch throws / times out → a "Packs unavailable" message.
 * - fetch succeeds → one `router-pack` per id (or the "No packs" message).
 */
export async function resolveRouterPackChildren(
  status: LlmEndpointStatusResult | null,
  fetchPacks: PacksFetcher,
): Promise<LocalRouterNode[]> {
  if (!routerServing(status)) return []
  const baseUrl = routerBaseUrl(status)
  if (!baseUrl) {
    return [{ kind: "router-message", message: "Router address unavailable" }]
  }
  try {
    const packs = await fetchPacks(baseUrl)
    return buildRouterPackChildren(packs)
  } catch {
    return [{ kind: "router-message", message: "Packs unavailable" }]
  }
}
