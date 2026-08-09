/**
 * Pure "Wallets" webview model — no vscode import so it's unit-testable under
 * plain vitest. Groups auth profiles into provider columns via the mind map's
 * {@link buildProviders}/{@link accessKind} (authModelMindmap.logic.ts), so
 * this sidebar and the Auth & Model Map agree on what a wallet is by
 * construction, not by convention. Presets with no wallet yet surface as a
 * separate "connect a provider" list.
 */

import type {
  AuthProfileSummary,
  LlmEndpointStatusResult,
  ProviderPresetEntry,
} from "../client/types.js"
import {
  buildProviders,
  type ProviderView,
  type WalletView,
} from "./authModelMindmap.logic.js"
import {
  routerDescription,
  routerLabel,
  routerRunning,
  routerServing,
} from "../views/localRouterTree.logic.js"
import { adapterLogoFor, type AdapterLogo } from "./adapterIcon.logic.js"

export type AuthProfileStatus = "ready" | "available" | "dim" | "unconnected"

export interface WalletWebviewRow extends WalletView {
  /** Convenience mirror of `!disabled`, so the panel toggles without
   *  re-deriving it from the wallet's `disabled` flag every time. */
  enabled: boolean
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

function toWalletRow(w: WalletView): WalletWebviewRow {
  return { ...w, enabled: !w.disabled }
}

function toProviderRow(p: ProviderView): ProviderWebviewRow {
  return {
    endpoint: p.endpoint,
    native: p.native,
    logo: adapterLogoFor(p.endpoint),
    wallets: p.wallets.map(toWalletRow),
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
 * Local Router status — all from the daemon's live auth profiles + presets.
 */
export function buildAuthProfilesWebviewModel(
  presets: readonly ProviderPresetEntry[],
  profiles: readonly AuthProfileSummary[],
  routerStatus: LlmEndpointStatusResult | null,
  search: string,
  expanded: AuthProfilesExpandedState,
  showAllProviders: boolean,
): AuthProfilesWebviewModel {
  const allProviders = buildProviders([...profiles], new Map()).map(toProviderRow)

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
