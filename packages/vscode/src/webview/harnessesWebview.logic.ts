/**
 * Pure Harnesses webview model — no vscode import so it's unit-testable under
 * plain vitest. Reshapes the daemon's AdapterInfo list into the flat row model
 * the webview paints, mirroring the Sessions webview's logic/panel split.
 *
 * The per-provider reach strip and the wallet badge come straight from
 * {@link buildAuthModel} (authModelMindmap.logic.ts) — the same computation
 * the Auth & Model Map draws its edges from — so a harness card and the map
 * can never disagree about what a harness can reach or bill. Manifest facts
 * (speaks / route / base_url) live only in the map's harness drawer now —
 * the card no longer repeats them.
 */

import type { AdapterInfo, AuthProfileSummary, HarnessCapabilities, LlmEndpointStatusResult } from "../client/types.js"
import { canInstallHarness, harnessDescription } from "../views/harnessesTree.logic.js"
import { adapterLogoFor, type AdapterLogo } from "./adapterIcon.logic.js"
import { buildAuthModel, type HarnessView, type ProviderView, type ReachState } from "./authModelMindmap.logic.js"

export type HarnessStatus = "ready" | "available" | "dim"

/**
 * The row's single labeled action button — always the same slot, never a
 * hover-swap:
 * - "start"      — installed harness, real `<button>` "▶ Start"
 * - "install"    — not yet installed, click kicks off adapter_install
 * - "installing" — optimistic state the panel sets right after the click,
 *   held until the next adapters refresh lands (panel-side; see
 *   harnessesWebviewPanel.ts). A row can only be "installing" while it's
 *   still installable — once the underlying adapter reports installed, the
 *   action falls back to "start" regardless of any stale optimistic flag.
 */
export type HarnessAction = "start" | "install" | "installing"

/** One provider this harness can reach, for the card's reach strip. */
export interface HarnessReachEntry {
  endpoint: string
  state: ReachState
}

/**
 * The card's billing-connection summary, replacing the old manifest line.
 * Always clickable to `endpoint` EXCEPT when the harness reaches no provider
 * at all (nothing to connect, nowhere to navigate) — `endpoint: null` then.
 */
export interface HarnessWalletBadge {
  /** e.g. "2 wallets", "moonshot-api" (single wallet, shows its label), or
   *  "no wallet" (a reachable provider exists but nothing is connected). */
  label: string
  /** The provider endpoint this badge anchors navigation to, or null when
   *  the harness has no reachable provider to navigate to. */
  endpoint: string | null
}

export interface HarnessWebviewRow {
  slug: string
  name: string
  description: string
  status: HarnessStatus
  installable: boolean
  action: HarnessAction
  logo: AdapterLogo
  /** Billing-connection badge — wallet count or the sole wallet's label,
   *  clickable through to the Auth & Model Map anchored on its provider. */
  walletBadge: HarnessWalletBadge
  /** Reach strip for the map's primary (non-folded) providers, provider order
   *  matching the map (busiest first). Empty when the harness reaches none of
   *  them (e.g. no wallets exist yet for any provider it can reach). */
  reach: HarnessReachEntry[]
  /** How many more providers (beyond the reach strip) this harness reaches,
   *  folded the same way the map folds its provider columns. */
  hiddenReachCount: number
  /** True when this harness has a verified native-terminal launch path (a
   *  real CLI/TUI binary, not just an ACP arm) AND is installed — the "Terminal"
   *  button only ever shows next to `action === "start"`. */
  canOpenTerminal: boolean
}

export interface HarnessesWebviewModel {
  rows: HarnessWebviewRow[]
  shownCount: number
  totalCount: number
}

export function harnessStatusFor(status: string | undefined): HarnessStatus {
  if (status === "ready") return "ready"
  if (status === "available" || status === "supported") return "available"
  return "dim"
}

const STATUS_RANK: Record<string, number> = {
  ready: 0,
  available: 1,
  supported: 2,
}

function rawStatusRank(status: string | undefined): number {
  return status === undefined ? Number.POSITIVE_INFINITY : (STATUS_RANK[status] ?? Number.POSITIVE_INFINITY)
}

function rowMatchesSearch(row: HarnessWebviewRow, search: string): boolean {
  if (search.length === 0) return true
  const term = search.toLowerCase()
  return (
    row.slug.toLowerCase().includes(term) ||
    row.name.toLowerCase().includes(term) ||
    row.description.toLowerCase().includes(term)
  )
}

function actionFor(installable: boolean, installing: boolean): HarnessAction {
  if (!installable) return "start"
  return installing ? "installing" : "install"
}

/**
 * Summarise a harness's billing connections from the providers it can reach.
 * Picks the busiest reachable endpoint (most wallets, ties broken by name)
 * as the navigation anchor — the single most useful place to land a click.
 * `endpoint: null` only when the harness reaches no provider at all.
 */
function walletBadgeFor(
  view: HarnessView,
  providerByEndpoint: ReadonlyMap<string, ProviderView>,
): HarnessWalletBadge {
  const endpoints = Object.keys(view.reach)
  if (endpoints.length === 0) return { label: "no reachable provider", endpoint: null }

  let anchor = endpoints[0]!
  let anchorWallets = providerByEndpoint.get(anchor)?.wallets.length ?? 0
  let totalWallets = anchorWallets
  for (const ep of endpoints.slice(1)) {
    const count = providerByEndpoint.get(ep)?.wallets.length ?? 0
    totalWallets += count
    if (count > anchorWallets || (count === anchorWallets && ep < anchor)) {
      anchor = ep
      anchorWallets = count
    }
  }
  if (totalWallets === 0) return { label: "no wallet", endpoint: anchor }
  if (totalWallets === 1) {
    const only = endpoints.flatMap(ep => providerByEndpoint.get(ep)?.wallets ?? [])[0]!
    return { label: only.label, endpoint: only.endpoint }
  }
  return { label: `${totalWallets} wallets`, endpoint: anchor }
}

function toRow(
  adapter: AdapterInfo,
  installingSlugs: ReadonlySet<string>,
  harnessViewBySlug: ReadonlyMap<string, HarnessView>,
  primaryEndpoints: readonly string[],
  providerByEndpoint: ReadonlyMap<string, ProviderView>,
  nativeTerminalSlugs: ReadonlySet<string>,
): HarnessWebviewRow {
  const installable = canInstallHarness(adapter.status)
  // buildAuthModel always emits a HarnessView for every adapter slug it's
  // given (speaksOf/routePosture fall back to sane defaults with no live
  // capabilities) — so this is never undefined for an adapter in `adapters`.
  const view = harnessViewBySlug.get(adapter.slug)!
  const reach: HarnessReachEntry[] = []
  for (const endpoint of primaryEndpoints) {
    const state = view.reach[endpoint]
    if (state) reach.push({ endpoint, state })
  }
  const hiddenReachCount = Object.keys(view.reach).length - reach.length
  const action = actionFor(installable, installingSlugs.has(adapter.slug))
  return {
    slug: adapter.slug,
    name: adapter.name?.trim() || adapter.slug,
    description: harnessDescription(adapter),
    status: harnessStatusFor(adapter.status),
    installable,
    action,
    logo: adapterLogoFor(adapter.slug),
    walletBadge: walletBadgeFor(view, providerByEndpoint),
    reach,
    hiddenReachCount,
    canOpenTerminal: action === "start" && nativeTerminalSlugs.has(adapter.slug),
  }
}

export function buildHarnessesWebviewModel(
  adapters: readonly AdapterInfo[],
  search: string,
  installingSlugs: ReadonlySet<string> = new Set(),
  capabilities: readonly HarnessCapabilities[] = [],
  profiles: readonly AuthProfileSummary[] = [],
  router: LlmEndpointStatusResult | null = null,
  /** Adapter slugs with a verified native terminal/TUI launch path (see
   *  `NATIVE_LAUNCH_ARGV` in runtime's conversation-store.ts) — gates the
   *  card's "Terminal" button. Empty by default so callers that don't pass
   *  it (e.g. existing tests) never show a button with nothing to launch. */
  nativeTerminalSlugs: ReadonlySet<string> = new Set(),
): HarnessesWebviewModel {
  const authModel = buildAuthModel({ adapters: [...adapters], capabilities: [...capabilities], profiles: [...profiles], router })
  const harnessViewBySlug = new Map(authModel.harnesses.map(h => [h.slug, h]))
  const primaryEndpoints = authModel.providers.filter(p => p.primary).map(p => p.endpoint)
  const providerByEndpoint = new Map(authModel.providers.map(p => [p.endpoint, p]))

  const sorted = adapters
    .slice()
    .sort((a, b) => rawStatusRank(a.status) - rawStatusRank(b.status))
    .map(a => toRow(a, installingSlugs, harnessViewBySlug, primaryEndpoints, providerByEndpoint, nativeTerminalSlugs))
  const trimmed = search.trim()
  const visible = trimmed.length === 0 ? sorted : sorted.filter(r => rowMatchesSearch(r, trimmed))
  return { rows: visible, shownCount: visible.length, totalCount: adapters.length }
}
