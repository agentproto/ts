/**
 * Pure "Wallets" webview model — no vscode import so it's unit-testable under
 * plain vitest. Groups auth profiles into provider columns via the mind map's
 * {@link buildProviders}/{@link accessKind} (authModelMindmap.logic.ts), so
 * this sidebar and the Auth & Model Map agree on what a wallet is by
 * construction, not by convention. Presets with no wallet yet surface as a
 * separate "connect a provider" list.
 *
 * This is also the wallet-first home for what used to live in the (now
 * redirector) Auth Settings panel: a catalog-cross-referenced curation
 * summary per wallet ("N curated · N active") and the curated model ids for
 * the card's collapsed-by-default remove-chip editor — deliberately a single
 * summary line, not the old panel's always-on chip wall.
 */

import type {
  AuthProfileSummary,
  CatalogModelsResponse,
  LlmEndpointStatusResult,
  ProviderPresetEntry,
} from "../client/types.js"
import {
  buildProviders,
  type ProviderView,
  type WalletView,
} from "./authModelMindmap.logic.js"
import { profileCuratedIds } from "../views/authProfilesTree.logic.js"
import {
  routerDescription,
  routerLabel,
  routerRunning,
  routerServing,
} from "../views/localRouterTree.logic.js"
import { adapterLogoFor, type AdapterLogo } from "./adapterIcon.logic.js"

export type AuthProfileStatus = "ready" | "available" | "dim" | "unconnected"

/** Why a curated model is (not) usable through this wallet right now:
 *  `active` — this wallet bills it; `inactive` — the wallet is disabled or
 *  another wallet bills it; `unbillable` — the model is in the catalog but NO
 *  connected wallet can bill it (the "No connected profile can bill this
 *  model" spawn error, made visible before spawning); `unlisted` — the id
 *  matches nothing in the provider's catalog. */
export type CuratedModelStatus = "active" | "inactive" | "unbillable" | "unlisted"

export interface CuratedModelChip {
  id: string
  status: CuratedModelStatus
  /** Human one-liner for the chip tooltip — states the reason, not just the color. */
  hint: string
}

export interface WalletWebviewRow extends WalletView {
  /** Convenience mirror of `!disabled`, so the panel toggles without
   *  re-deriving it from the wallet's `disabled` flag every time. */
  enabled: boolean
  /** Catalog-cross-referenced summary, e.g. "6 curated · 4 active" or
   *  "no catalog models" or "0 active · 6 catalog (disabled)" — one line, not
   *  a wall of per-model pills. */
  curationSummary: string
  /** Curated model ids (only when the profile is in `allow` mode) — rendered
   *  as removable chips behind the card's collapsed-by-default curation
   *  editor. Empty means "allows all". */
  curatedIds: string[]
  /** The same curated ids joined against the catalog, one status + hint per
   *  chip — how the card shows WHY a curated model isn't active. */
  curatedModels: CuratedModelChip[]
}

export interface ProviderWebviewRow {
  endpoint: string
  native: string
  logo: AdapterLogo
  wallets: WalletWebviewRow[]
  subscriptionCount: number
  apiKeyCount: number
  /** True for the default-visible providers; false ⇒ behind "more", same
   *  {@link DEFAULT_PROVIDER_COUNT} fold rule as the Auth & Model Map. */
  primary: boolean
}

export interface UnconnectedProviderRow {
  slug: string
  name: string
  logo: AdapterLogo
}

export interface RouterWebviewRow {
  kind: "router"
  name: string
  description: string
  status: AuthProfileStatus
}

export interface AuthProfilesSection<T> {
  kind: "providers" | "router"
  label: string
  count: number | string
  expanded: boolean
  rows: T[]
}

export interface AuthProfilesWebviewModel {
  providers: AuthProfilesSection<ProviderWebviewRow>
  /** Providers with zero wallets — surfaced separately with a Connect
   *  affordance rather than folded into the wallet-card grid. */
  unconnected: UnconnectedProviderRow[]
  /** How many primary-fold providers are hidden behind "more" right now
   *  (0 while searching or once expanded). */
  moreCount: number
  router: AuthProfilesSection<RouterWebviewRow>
}

export interface AuthProfilesExpandedState {
  providers: boolean
  router: boolean
}

export function routerStatusFor(status: LlmEndpointStatusResult | null): AuthProfileStatus {
  if (!status) return "dim"
  if (status.status === "starting") return "available"
  if (routerServing(status)) return "ready"
  if (routerRunning(status)) return "available"
  return "dim"
}

function routerCountLabel(status: LlmEndpointStatusResult | null): string {
  if (!status) return "stopped"
  if (status.status === "never-started") return "stopped"
  if (routerServing(status)) return "healthy"
  return status.status
}

/**
 * Per-model curation gate — local mirror of the predicate in
 * `packages/runtime/src/catalog-models.ts`. An absent/`all` curation admits
 * everything; an `allow` curation admits the model when its id appears as the
 * route-qualified `ref`, the route-independent `vendor/product`, or (on a
 * direct route only) the bare product.
 */
function profileAllowsModel(profile: AuthProfileSummary, ref: string, vendorProduct: string): boolean {
  const curation = profile.models
  if (!curation || curation.mode === "all") return true
  const slash = vendorProduct.indexOf("/")
  const product = slash === -1 ? vendorProduct : vendorProduct.slice(slash + 1)
  const isDirect = !ref.includes("@")
  return (
    curation.ids.includes(ref) || curation.ids.includes(vendorProduct) || (isDirect && curation.ids.includes(product))
  )
}

interface WalletCatalogCounts {
  catalogCount: number
  curatedCount: number
  runnableCount: number
}

/**
 * Counts for a single wallet against the catalog join, scoped to the wallet's
 * own billing endpoint (`route.route === profile.endpoint`) — keeps native
 * `xai` and `xai-anthropic` profiles from cross-qualifying.
 */
function walletCatalogCounts(profile: AuthProfileSummary, enabled: boolean, catalog: CatalogModelsResponse): WalletCatalogCounts {
  let catalogCount = 0
  let curatedCount = 0
  let runnableCount = 0
  for (const vendor of catalog.vendors ?? []) {
    for (const product of vendor.products ?? []) {
      for (const route of product.routes ?? []) {
        if (route.route !== profile.endpoint) continue
        catalogCount++
        const vendorProduct = `${vendor.vendor}/${product.product}`
        if (profileAllowsModel(profile, route.ref, vendorProduct)) curatedCount++
        if (enabled && route.runnable && route.eligibleProfiles.includes(profile.id)) runnableCount++
      }
    }
  }
  return { catalogCount, curatedCount, runnableCount }
}

/** One summary line for the wallet card — deliberately terse: two numbers,
 *  not a three-clause catalog/curated/active/excluded breakdown. */
function curationSummaryFor(enabled: boolean, counts: WalletCatalogCounts): string {
  if (!enabled) return `0 active · ${counts.catalogCount} catalog (disabled)`
  if (counts.catalogCount === 0) return "no catalog models"
  return `${counts.curatedCount} curated · ${counts.runnableCount} active`
}

/** Same id↔route matching as {@link profileAllowsModel}, inverted: does this
 *  catalog route answer to the curated id? */
function routeMatchesId(id: string, ref: string, vendorProduct: string): boolean {
  const slash = vendorProduct.indexOf("/")
  const product = slash === -1 ? vendorProduct : vendorProduct.slice(slash + 1)
  const isDirect = !ref.includes("@")
  return id === ref || id === vendorProduct || (isDirect && id === product)
}

/**
 * Join one curated id against the wallet's slice of the catalog and say why
 * it is (not) usable — this is where "model not active" and "no billing
 * wallet" stop looking identical.
 */
function curatedChipFor(
  profile: AuthProfileSummary,
  enabled: boolean,
  catalog: CatalogModelsResponse,
  id: string,
): CuratedModelChip {
  let matched = false
  let activeHere = false
  let runnableElsewhere = false
  for (const vendor of catalog.vendors ?? []) {
    for (const product of vendor.products ?? []) {
      for (const route of product.routes ?? []) {
        if (route.route !== profile.endpoint) continue
        if (!routeMatchesId(id, route.ref, `${vendor.vendor}/${product.product}`)) continue
        matched = true
        if (route.runnable && route.eligibleProfiles.includes(profile.id)) activeHere = true
        else if (route.runnable) runnableElsewhere = true
      }
    }
  }
  if (!enabled) return { id, status: "inactive", hint: "wallet disabled — enable it to serve this model" }
  if (activeHere) return { id, status: "active", hint: "active — this wallet bills it" }
  if (runnableElsewhere) return { id, status: "inactive", hint: "not billed by this wallet — another connected wallet serves it" }
  if (matched) {
    return {
      id,
      status: "unbillable",
      hint: `no connected wallet can bill this model on ${profile.endpoint} — check this wallet's credential`,
    }
  }
  return { id, status: "unlisted", hint: `not in the ${profile.endpoint} catalog — check the model id` }
}

function toWalletRow(w: WalletView, profile: AuthProfileSummary | undefined, catalog: CatalogModelsResponse): WalletWebviewRow {
  const enabled = !w.disabled
  const counts = profile ? walletCatalogCounts(profile, enabled, catalog) : { catalogCount: 0, curatedCount: 0, runnableCount: 0 }
  const curatedIds = profileCuratedIds(profile)
  return {
    ...w,
    enabled,
    curationSummary: curationSummaryFor(enabled, counts),
    curatedIds,
    curatedModels: profile ? curatedIds.map(id => curatedChipFor(profile, enabled, catalog, id)) : [],
  }
}

function toProviderRow(
  p: ProviderView,
  profileById: ReadonlyMap<string, AuthProfileSummary>,
  catalog: CatalogModelsResponse,
): ProviderWebviewRow {
  return {
    endpoint: p.endpoint,
    native: p.native,
    logo: adapterLogoFor(p.endpoint),
    wallets: p.wallets.map(w => toWalletRow(w, profileById.get(w.id), catalog)),
    subscriptionCount: p.subscriptionCount,
    apiKeyCount: p.apiKeyCount,
    primary: p.primary,
  }
}

function providerMatchesSearch(row: ProviderWebviewRow, term: string): boolean {
  if (row.endpoint.toLowerCase().includes(term)) return true
  if (row.native.toLowerCase().includes(term)) return true
  return row.wallets.some(w => w.label.toLowerCase().includes(term) || w.id.toLowerCase().includes(term))
}

function presetMatchesSearch(row: UnconnectedProviderRow, term: string): boolean {
  return row.slug.toLowerCase().includes(term) || row.name.toLowerCase().includes(term)
}

/**
 * Build the "Wallets" webview model: provider groups (with wallet cards)
 * folded at {@link DEFAULT_PROVIDER_COUNT}, unconnected presets, and the
 * Local Router status — all from the daemon's live auth profiles + presets +
 * catalog.
 */
export function buildAuthProfilesWebviewModel(
  presets: readonly ProviderPresetEntry[],
  profiles: readonly AuthProfileSummary[],
  catalog: CatalogModelsResponse,
  routerStatus: LlmEndpointStatusResult | null,
  search: string,
  expanded: AuthProfilesExpandedState,
  showAllProviders: boolean,
): AuthProfilesWebviewModel {
  const profileById = new Map(profiles.map(p => [p.id, p]))
  const allProviders = buildProviders([...profiles], new Map()).map(p => toProviderRow(p, profileById, catalog))

  const trimmed = search.trim().toLowerCase()
  const filteredProviders = trimmed.length === 0 ? allProviders : allProviders.filter(p => providerMatchesSearch(p, trimmed))
  const visibleProviders =
    showAllProviders || trimmed.length > 0 ? filteredProviders : filteredProviders.filter(p => p.primary)
  const moreCount = showAllProviders || trimmed.length > 0 ? 0 : filteredProviders.length - visibleProviders.length

  const connectedEndpoints = new Set(profiles.map(p => p.endpoint))
  const unconnectedAll: UnconnectedProviderRow[] = [...presets]
    .filter(preset => !connectedEndpoints.has(preset.slug))
    .map(preset => ({
      slug: preset.slug,
      name: preset.name?.trim() || preset.slug,
      logo: adapterLogoFor(preset.slug),
    }))
  const unconnected = trimmed.length === 0 ? unconnectedAll : unconnectedAll.filter(u => presetMatchesSearch(u, trimmed))

  const routerRows: RouterWebviewRow[] = [
    {
      kind: "router",
      name: routerLabel(routerStatus),
      description: routerDescription(routerStatus),
      status: routerStatusFor(routerStatus),
    },
  ]
  const visibleRouter = trimmed.length === 0 ? routerRows : routerRows.filter(r => r.name.toLowerCase().includes(trimmed))

  const totalWallets = filteredProviders.reduce((n, p) => n + p.wallets.length, 0)

  return {
    providers: {
      kind: "providers",
      label: "Wallets",
      count: totalWallets,
      expanded: expanded.providers,
      rows: visibleProviders,
    },
    unconnected,
    moreCount,
    router: {
      kind: "router",
      label: "Local Router",
      count: routerCountLabel(routerStatus),
      expanded: expanded.router,
      rows: visibleRouter,
    },
  }
}
