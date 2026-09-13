/**
 * Pure view model for the Auth & Models EXPLORER — the editable, master-detail
 * successor to the read-only Auth & Model Map, implementing the approved
 * `auth-explorer-mockup.html` design (left rail: providers → wallets,
 * harnesses → presets, multi-served models pivot; right: detail pages with a
 * per-wallet allowed-models editor).
 *
 * No `vscode` import so it unit-tests under plain vitest. All joins run
 * against the daemon's live data: provider presets, auth profiles, the
 * catalog_models route join (runnable + eligibleProfiles = billing truth),
 * adapters, user presets (spawn favorites), and llm-endpoint upstream links.
 */

import type {
  AdapterInfo,
  AuthProfileSummary,
  CatalogModelsResponse,
  LlmEndpointLinksResult,
  LlmEndpointStatusResult,
  ProviderPresetEntry,
  UserPreset,
} from "../client/types.js"
import { accessKind, type AccessKind } from "./authModelMindmap.logic.js"
import { profileCuratedIds } from "../views/authProfilesTree.logic.js"
import { routerLabel, routerServing } from "../views/localRouterTree.logic.js"

/** Why a catalog model is (not) usable through a wallet right now. */
export type ExplorerModelStatus = "active" | "inactive" | "unbillable"

/** One catalog model row scoped to a wallet's endpoint — the unit the
 *  allowed-models editor toggles. `writeId` is the route-independent
 *  `vendor/product` id the curation allowlist stores. */
export interface ExplorerModelRow {
  vendor: string
  product: string
  /** Route-qualified catalog ref, e.g. `deepseek/deepseek-v4@openrouter`. */
  ref: string
  /** The id written to the allowlist on toggle — always `vendor/product`. */
  writeId: string
  /** Whether the wallet's curation currently admits this model. */
  allowed: boolean
  /** Billing truth from the catalog join. */
  status: ExplorerModelStatus
  /** Human reason behind `status` — tooltip text. */
  hint: string
  /** "in/out per 1M" price tag, when the catalog carries one. */
  price?: string
}

export interface ExplorerWalletView {
  id: string
  label: string
  endpoint: string
  accessKind: AccessKind
  enabled: boolean
  /** Non-secret credential line, e.g. "oauth · auto-refresh (claude-code-oauth)"
   *  or "key fp 6931 · ····c160". */
  credential: string
  keyStatus?: string
  origin?: string
  curationMode: "all" | "allow"
  /** Allowlist ids that match NO catalog route on this endpoint — preserved
   *  verbatim on writes, surfaced as "unlisted" chips. */
  unlistedIds: string[]
  models: ExplorerModelRow[]
  catalogCount: number
  allowedCount: number
  activeCount: number
  /** Spawn presets (favorites) whose access.profileRef points here. */
  usedByPresets: ExplorerPresetRef[]
  /** Upstream providers linked to this wallet on the local router. */
  upstreamOf: string[]
}

export interface ExplorerPresetRef {
  id: string
  label: string
  harness?: string
  model?: string
}

export interface ExplorerProviderView {
  slug: string
  name: string
  connected: boolean
  wallets: ExplorerWalletView[]
  /** Local-router upstream link state for this provider, when the router
   *  knows the upstream. */
  upstream?: {
    linkedProfile: string | null
    eligible: { id: string; label: string }[]
  }
}

export interface ExplorerHarnessView {
  slug: string
  name: string
  protocol?: string
  version?: string
  presets: ExplorerPresetRef[]
}

export interface ExplorerModelPivot {
  /** `vendor/product` — the route-independent model identity. */
  key: string
  servedBy: {
    profileId: string
    label: string
    endpoint: string
    ref: string
    active: boolean
  }[]
}

export interface AuthExplorerView {
  providers: ExplorerProviderView[]
  harnesses: ExplorerHarnessView[]
  /** Models served by ≥2 wallets — the pivot rail section. */
  multiServed: ExplorerModelPivot[]
  router: { running: boolean; label: string }
  counts: { wallets: number; providers: number; harnesses: number; presets: number }
}

export interface AuthExplorerData {
  presets: readonly ProviderPresetEntry[]
  profiles: readonly AuthProfileSummary[]
  catalog: CatalogModelsResponse
  adapters: readonly AdapterInfo[]
  userPresets: readonly UserPreset[]
  links: LlmEndpointLinksResult | null
  routerStatus: LlmEndpointStatusResult | null
}

/** Same admit rule as the runtime's curation gate: ref, `vendor/product`, or
 *  (direct route only) bare product. */
function curationAdmits(ids: readonly string[], ref: string, vendorProduct: string): boolean {
  const slash = vendorProduct.indexOf("/")
  const product = slash === -1 ? vendorProduct : vendorProduct.slice(slash + 1)
  const isDirect = !ref.includes("@")
  return ids.includes(ref) || ids.includes(vendorProduct) || (isDirect && ids.includes(product))
}

function credentialLine(p: AuthProfileSummary): string {
  if (p.source) return `oauth · auto-refresh (${p.source})`
  if (p.keyStatus === "stored" && p.last4) {
    return p.fingerprint ? `key fp ${p.fingerprint} · ····${p.last4}` : `key ····${p.last4}`
  }
  if (p.keyStatus === "unavailable") return "credential unavailable"
  return "stored credential"
}

function priceLabel(pricing: { inPer1M: number; outPer1M: number } | null): string | undefined {
  if (!pricing) return undefined
  return `$${pricing.inPer1M}/$${pricing.outPer1M} per 1M`
}

function walletModelRows(
  profile: AuthProfileSummary,
  enabled: boolean,
  catalog: CatalogModelsResponse,
): { rows: ExplorerModelRow[]; unlisted: string[] } {
  const curatedIds = profileCuratedIds(profile)
  const mode: "all" | "allow" = profile.models?.mode === "allow" ? "allow" : "all"
  const rows: ExplorerModelRow[] = []
  const matchedIds = new Set<string>()
  for (const vendor of catalog.vendors ?? []) {
    for (const product of vendor.products ?? []) {
      for (const route of product.routes ?? []) {
        if (route.route !== profile.endpoint) continue
        const writeId = `${vendor.vendor}/${product.product}`
        const allowed = mode === "all" || curationAdmits(curatedIds, route.ref, writeId)
        if (mode === "allow") {
          const admitIds = route.ref.includes("@")
            ? [route.ref, writeId]
            : [route.ref, writeId, product.product]
          for (const id of admitIds) {
            if (curatedIds.includes(id)) matchedIds.add(id)
          }
        }
        const activeHere = route.runnable && route.eligibleProfiles.includes(profile.id)
        let status: ExplorerModelStatus
        let hint: string
        if (!enabled) {
          status = "inactive"
          hint = "wallet disabled — enable it to serve this model"
        } else if (activeHere) {
          status = "active"
          hint = "active — this wallet bills it"
        } else if (route.runnable) {
          status = "inactive"
          hint = "not billed by this wallet — another connected wallet serves it"
        } else {
          status = "unbillable"
          hint = `no connected wallet can bill this model on ${profile.endpoint} — check this wallet's credential`
        }
        rows.push({
          vendor: vendor.vendor,
          product: product.product,
          ref: route.ref,
          writeId,
          allowed,
          status,
          hint,
          price: priceLabel(route.pricing),
        })
      }
    }
  }
  rows.sort((a, b) => (a.vendor === b.vendor ? a.product.localeCompare(b.product) : a.vendor.localeCompare(b.vendor)))
  const unlisted = mode === "allow" ? curatedIds.filter(id => !matchedIds.has(id)) : []
  return { rows, unlisted }
}

function toWalletView(
  profile: AuthProfileSummary,
  catalog: CatalogModelsResponse,
  userPresets: readonly UserPreset[],
  links: LlmEndpointLinksResult | null,
): ExplorerWalletView {
  const enabled = profile.disabled !== true
  const { rows, unlisted } = walletModelRows(profile, enabled, catalog)
  const usedByPresets = userPresets
    .filter(p => p.access?.profileRef === profile.id)
    .map(p => ({ id: p.id, label: p.label, harness: p.harness ?? p.adapter, model: p.model }))
  const upstreamOf = Object.entries(links?.links ?? {})
    .filter(([, profileId]) => profileId === profile.id)
    .map(([provider]) => provider)
    .sort()
  return {
    id: profile.id,
    label: profile.label?.trim() || profile.id,
    endpoint: profile.endpoint,
    accessKind: accessKind(profile),
    enabled,
    credential: credentialLine(profile),
    keyStatus: profile.keyStatus,
    origin: profile.origin,
    curationMode: profile.models?.mode === "allow" ? "allow" : "all",
    unlistedIds: unlisted,
    models: rows,
    catalogCount: rows.length,
    allowedCount: rows.filter(r => r.allowed).length,
    activeCount: rows.filter(r => r.status === "active").length,
    usedByPresets,
    upstreamOf,
  }
}

/**
 * Build the full explorer view. Providers = union of provider presets and
 * endpoints that already have wallets (so a wallet on an endpoint with no
 * preset still shows). Sorted: connected first, then alphabetical.
 */
export function buildAuthExplorerView(data: AuthExplorerData): AuthExplorerView {
  const wallets = data.profiles.map(p => toWalletView(p, data.catalog, data.userPresets, data.links))
  const walletsByEndpoint = new Map<string, ExplorerWalletView[]>()
  for (const w of wallets) {
    const list = walletsByEndpoint.get(w.endpoint) ?? []
    list.push(w)
    walletsByEndpoint.set(w.endpoint, list)
  }

  const slugs = new Set<string>([...data.presets.map(p => p.slug), ...walletsByEndpoint.keys()])
  const upstreamByProvider = new Map((data.links?.upstreams ?? []).map(u => [u.provider, u]))
  const providers: ExplorerProviderView[] = [...slugs]
    .map(slug => {
      const preset = data.presets.find(p => p.slug === slug)
      const upstream = upstreamByProvider.get(slug)
      return {
        slug,
        name: preset?.name?.trim() || slug,
        connected: walletsByEndpoint.has(slug),
        wallets: walletsByEndpoint.get(slug) ?? [],
        ...(upstream
          ? {
              upstream: {
                linkedProfile: upstream.linkedProfile,
                eligible: upstream.eligible.map(e => ({ id: e.id, label: e.label?.trim() || e.id })),
              },
            }
          : {}),
      }
    })
    .sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1
      return a.slug.localeCompare(b.slug)
    })

  const presetsByHarness = new Map<string, ExplorerPresetRef[]>()
  for (const p of data.userPresets) {
    const key = p.harness ?? p.adapter ?? ""
    const list = presetsByHarness.get(key) ?? []
    list.push({ id: p.id, label: p.label, harness: key || undefined, model: p.model })
    presetsByHarness.set(key, list)
  }
  const harnesses: ExplorerHarnessView[] = data.adapters
    .map(a => ({
      slug: a.slug,
      name: a.name?.trim() || a.slug,
      protocol: a.protocol,
      version: a.version,
      presets: presetsByHarness.get(a.slug) ?? [],
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug))

  const pivot = new Map<string, ExplorerModelPivot["servedBy"]>()
  for (const w of wallets) {
    for (const row of w.models) {
      if (!(row.allowed && row.status === "active")) continue
      const list = pivot.get(row.writeId) ?? []
      list.push({ profileId: w.id, label: w.label, endpoint: w.endpoint, ref: row.ref, active: true })
      pivot.set(row.writeId, list)
    }
  }
  const multiServed: ExplorerModelPivot[] = [...pivot.entries()]
    .filter(([, servedBy]) => servedBy.length >= 2)
    .map(([key, servedBy]) => ({ key, servedBy }))
    .sort((a, b) => b.servedBy.length - a.servedBy.length || a.key.localeCompare(b.key))

  return {
    providers,
    harnesses,
    multiServed,
    router: {
      running: data.routerStatus ? routerServing(data.routerStatus) : false,
      label: routerLabel(data.routerStatus),
    },
    counts: {
      wallets: wallets.length,
      providers: providers.filter(p => p.connected).length,
      harnesses: harnesses.length,
      presets: data.userPresets.length,
    },
  }
}

/**
 * Compute the allowlist write after toggling one model row. Works on the
 * CURRENT wallet view (mode + rows + unlisted ids), returns the `(mode, ids)`
 * pair for `setAuthProfileModels`:
 * - toggling OFF under `all` narrows to an explicit allowlist of every other
 *   catalog model (plus preserved unlisted ids);
 * - toggling the last allowed id OFF keeps `allow` with the unlisted ids, or
 *   reverts to `all` when nothing remains (same "stop restricting" rule as
 *   the Wallets picker);
 * - unknown/unlisted allowlist entries are never dropped by a toggle.
 */
export function toggleWalletModel(
  wallet: Pick<ExplorerWalletView, "curationMode" | "models" | "unlistedIds">,
  writeId: string,
): { mode: "all" | "allow"; ids: string[] } {
  const allowedNow = new Set(wallet.models.filter(r => r.allowed).map(r => r.writeId))
  if (allowedNow.has(writeId)) allowedNow.delete(writeId)
  else allowedNow.add(writeId)
  if (allowedNow.size === wallet.models.length && wallet.unlistedIds.length === 0) {
    return { mode: "all", ids: [] }
  }
  const ids = [...new Set([...allowedNow, ...wallet.unlistedIds])].sort((a, b) => a.localeCompare(b))
  if (ids.length === 0) return { mode: "all", ids: [] }
  return { mode: "allow", ids }
}

/**
 * Vendor-level select/deselect-all: when every vendor model is allowed, drop
 * them all; otherwise allow them all. Same preservation rules as
 * {@link toggleWalletModel}.
 */
export function toggleWalletVendor(
  wallet: Pick<ExplorerWalletView, "curationMode" | "models" | "unlistedIds">,
  vendor: string,
): { mode: "all" | "allow"; ids: string[] } {
  const vendorRows = wallet.models.filter(r => r.vendor === vendor)
  const allOn = vendorRows.every(r => r.allowed)
  const allowedNow = new Set(wallet.models.filter(r => r.allowed).map(r => r.writeId))
  for (const row of vendorRows) {
    if (allOn) allowedNow.delete(row.writeId)
    else allowedNow.add(row.writeId)
  }
  if (allowedNow.size === wallet.models.length && wallet.unlistedIds.length === 0) {
    return { mode: "all", ids: [] }
  }
  const ids = [...new Set([...allowedNow, ...wallet.unlistedIds])].sort((a, b) => a.localeCompare(b))
  if (ids.length === 0) return { mode: "all", ids: [] }
  return { mode: "allow", ids }
}
