/**
 * Pure Harnesses webview model — no vscode import so it's unit-testable under
 * plain vitest. Reshapes the daemon's AdapterInfo list into the flat row model
 * the webview paints, mirroring the Sessions webview's logic/panel split.
 *
 * Manifest facts (speaks / route / base_url) and the per-provider reach strip
 * come straight from {@link buildAuthModel} (authModelMindmap.logic.ts) — the
 * same computation the Auth & Model Map draws its edges from — so a harness
 * card and the map can never disagree about what a harness can reach.
 */

import type { AdapterInfo, AuthProfileSummary, HarnessCapabilities, LlmEndpointStatusResult } from "../client/types.js"
import { canInstallHarness, harnessDescription } from "../views/harnessesTree.logic.js"
import { adapterLogoFor, type AdapterLogo } from "./adapterIcon.logic.js"
import { buildAuthModel, type HarnessView, type ReachState, type RoutePosture } from "./authModelMindmap.logic.js"

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

/** Manifest facts surfaced on the card, straight from the mind map's
 *  {@link HarnessView} — never recomputed here. */
export interface HarnessManifestFacts {
  speaks: HarnessView["speaks"]
  route: RoutePosture
  acceptsBaseUrl: boolean
}

export interface HarnessWebviewRow {
  slug: string
  name: string
  description: string
  status: HarnessStatus
  installable: boolean
  action: HarnessAction
  logo: AdapterLogo
  /** Manifest facts computed from the daemon's live capabilities, falling
   *  back to a fixed/derived default when the daemon reports none (e.g. a
   *  not-yet-installed harness). */
  manifest: HarnessManifestFacts
  /** Reach strip for the map's primary (non-folded) providers, provider order
   *  matching the map (busiest first). Empty when the harness reaches none of
   *  them (e.g. no wallets exist yet for any provider it can reach). */
  reach: HarnessReachEntry[]
  /** How many more providers (beyond the reach strip) this harness reaches,
   *  folded the same way the map folds its provider columns. */
  hiddenReachCount: number
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

function toRow(
  adapter: AdapterInfo,
  installingSlugs: ReadonlySet<string>,
  harnessViewBySlug: ReadonlyMap<string, HarnessView>,
  primaryEndpoints: readonly string[],
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
  return {
    slug: adapter.slug,
    name: adapter.name?.trim() || adapter.slug,
    description: harnessDescription(adapter),
    status: harnessStatusFor(adapter.status),
    installable,
    action: actionFor(installable, installingSlugs.has(adapter.slug)),
    logo: adapterLogoFor(adapter.slug),
    manifest: { speaks: view.speaks, route: view.route, acceptsBaseUrl: view.acceptsBaseUrl },
    reach,
    hiddenReachCount,
  }
}

export function buildHarnessesWebviewModel(
  adapters: readonly AdapterInfo[],
  search: string,
  installingSlugs: ReadonlySet<string> = new Set(),
  capabilities: readonly HarnessCapabilities[] = [],
  profiles: readonly AuthProfileSummary[] = [],
  router: LlmEndpointStatusResult | null = null,
): HarnessesWebviewModel {
  const authModel = buildAuthModel({ adapters: [...adapters], capabilities: [...capabilities], profiles: [...profiles], router })
  const harnessViewBySlug = new Map(authModel.harnesses.map(h => [h.slug, h]))
  const primaryEndpoints = authModel.providers.filter(p => p.primary).map(p => p.endpoint)

  const sorted = adapters
    .slice()
    .sort((a, b) => rawStatusRank(a.status) - rawStatusRank(b.status))
    .map(a => toRow(a, installingSlugs, harnessViewBySlug, primaryEndpoints))
  const trimmed = search.trim()
  const visible = trimmed.length === 0 ? sorted : sorted.filter(r => rowMatchesSearch(r, trimmed))
  return { rows: visible, shownCount: visible.length, totalCount: adapters.length }
}
