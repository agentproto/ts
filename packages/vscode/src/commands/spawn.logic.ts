/**
 * Pure spawn-wizard logic — cwd/workspace autodetection, quick-pick item
 * mapping, and spawn-options assembly. No `vscode` import so this is
 * directly unit-testable; the interactive wizard in spawn.ts calls into
 * these. vscode's own `WorkspaceFolder` is mirrored as `WorkspaceFolderLike`
 * so callers can pass plain data without this file depending on the vscode
 * module.
 */

import type { SpawnAgentOptions } from "../client/daemonClient.js"
import type {
  AdapterInfo,
  AdapterModelInfo,
  CatalogModelsResponse,
  CatalogProduct,
  CatalogRoute,
  CatalogVendor,
  RouteSpec,
  SessionDescriptor,
  UserPreset,
  WorkspacesConfig,
} from "../client/types.js"
import { findWorkspaceByPath, workspaceLabel } from "../services/workspaces.logic.js"

/**
 * adapter_list's actual daemon response (see
 * packages/cli/src/registry/resolve.ts `AdapterListing`) carries `models`,
 * `status`, and `hint` fields beyond the frozen client `AdapterInfo`
 * contract (client/types.ts). Extended locally rather than editing that
 * frozen file — every added field is optional, so a plain `AdapterInfo`
 * still satisfies this shape.
 */
export interface SpawnAdapterInfo extends AdapterInfo {
  models?: string[]
  status?: "supported" | "available" | "ready" | "unresolvable"
  hint?: string
}

/**
 * An adapter's declared models, normalised to `AdapterModelInfo[]` — the
 * daemon's structured projection when present, or each bare `models` id
 * lifted to `{id}` (provider unstated) for an older daemon / a test
 * fixture that only set the flat list. Every model-menu builder in this
 * module (the collapsed picker, the Configure… chain's provider step)
 * reads models through this so both stay in sync automatically.
 */
export function modelEntriesOf(adapter: SpawnAdapterInfo): AdapterModelInfo[] {
  if (adapter.modelDetails && adapter.modelDetails.length > 0) return adapter.modelDetails
  return (adapter.models ?? []).map((id) => ({ id }))
}

export interface AdapterQuickPickItem {
  label: string
  description?: string
  adapter: SpawnAdapterInfo
}

export const CUSTOM_MODEL_LABEL = "$(edit) custom…"

export interface ModelQuickPickItem {
  label: string
  custom?: boolean
}

export interface ModeQuickPickItem {
  label: string
  description?: string
  mode: string
}

/** Adapter picker: label = slug, description = hint/status; "ready" adapters sort first. */
export function mapAdapterQuickPickItems(adapters: SpawnAdapterInfo[]): AdapterQuickPickItem[] {
  const items = adapters.map(adapter => ({
    label: adapter.slug,
    description: adapter.hint ?? adapter.status ?? adapter.name,
    adapter,
  }))
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aReady = a.item.adapter.status === "ready" ? 0 : 1
      const bReady = b.item.adapter.status === "ready" ? 0 : 1
      if (aReady !== bReady) return aReady - bReady
      return a.index - b.index
    })
    .map(({ item }) => item)
}

/** Model picker: every declared model plus a trailing "custom…" entry. */
export function mapModelQuickPickItems(models: string[]): ModelQuickPickItem[] {
  return [...models.map(m => ({ label: m })), { label: CUSTOM_MODEL_LABEL, custom: true }]
}

/** Mode picker: only meaningful when the adapter declares modes at all. */
export function mapModeQuickPickItems(modes: SpawnAdapterInfo["modes"]): ModeQuickPickItem[] {
  return (modes ?? []).map(m => ({
    label: m.id,
    description: m.status_note ?? m.status,
    mode: m.id,
  }))
}

/** Star codicon that marks a favorite row as pinned in the quick-pick. */
const FAVORITE_ICON = "$(star-full)"

/**
 * Favorites picker group — one row per saved user preset (a favorite),
 * pinned ahead of the adapter/model rows (see prependPresetGroup) so a
 * saved combo is one Enter away with zero further input. Each row is
 * star-prefixed so it reads as a pinned favorite rather than just another
 * picker line. The row's description surfaces the resolved adapter/model up
 * front: the favorite expands server-side, and without this the row would
 * show only a label and nothing about what actually gets spawned — exactly
 * the silent-autodetection this wizard exists to avoid (see spawn.ts's
 * header comment). Kept named "favorite" in the UI copy, never "preset"
 * bare — provider/gateway presets are a different concept (user-presets.ts).
 */
export function mapPresetQuickPickItems(presets: UserPreset[]): SpawnQuickPickItem[] {
  return presets.map(preset => ({
    label: `${FAVORITE_ICON} ${preset.label}`,
    description: [preset.adapter ?? preset.harness, preset.model].filter(Boolean).join(" · ") || undefined,
    preset,
  }))
}

const FAVORITES_HEADING = "Favorites"

/**
 * Prepends a pinned "Favorites" separator group ahead of the given picker
 * items — a no-op when there are no saved favorites, so callers can call
 * this unconditionally on every spawn.
 */
export function prependPresetGroup(items: SpawnQuickPickItem[], presets: UserPreset[]): SpawnQuickPickItem[] {
  if (presets.length === 0) return items
  return [{ label: FAVORITES_HEADING, kind: SEPARATOR_KIND }, ...mapPresetQuickPickItems(presets), ...items]
}

export const CONFIGURE_LABEL = "$(gear) Configure…"
export const CUSTOM_MODEL_SECTION_LABEL = "Custom model…"

/**
 * Mirrors `vscode.QuickPickItemKind.Separator` (`-1`) without importing
 * `vscode` — this module is deliberately vscode-free so it stays directly
 * unit-testable. A plain `number` is structurally assignable to the real
 * enum (TypeScript's numeric-enum leniency), so `spawn.ts` can pass this
 * array straight to `showQuickPick` unchanged.
 */
const SEPARATOR_KIND = -1

export interface SpawnQuickPickItem {
  label: string
  description?: string
  /** The row's second, taller line (vscode's `QuickPickItem.detail`). Set on
   *  the rich one-click rows (favorites / recent) so a whole combo —
   *  harness · model · provider · where/when — reads at a glance instead of a
   *  slim single line. Absent on the drill-down/heading rows. */
  detail?: string
  /** Set only on a group-heading row (`SEPARATOR_KIND`) — vscode ignores
   *  every other field when this is set, and the row can't be picked. */
  kind?: number
  /** Absent on a heading row and on the trailing Configure… row. */
  adapter?: SpawnAdapterInfo
  model?: string
  /** The model's bound adapter mode (AIP-45 `models.allowed[].mode`), so
   *  picking a gateway model applies its routing mode automatically —
   *  without this a gateway model id spawns in the adapter's default mode
   *  (i.e. against the wrong provider). Absent for a native/unbound model. */
  mode?: string
  /** Row asks for a typed-in model id instead of spawning immediately. */
  custom?: boolean
  /** Entry-picker harness row: selecting it narrows to that harness's models
   *  (mapHarnessCatalogModelItems) rather than spawning — the drill-down step,
   *  not a leaf. Carries `adapter` (the harness) and no model. */
  harness?: boolean
  /** A one-click "latest used" row (deriveRecentSpawns): carries the full combo
   *  — adapter/model/mode/route/accessProfileRef — so it spawns immediately,
   *  reusing the exact wallet the past session billed (no route-access prompt). */
  recent?: boolean
  /** The named auth profile to bill, carried on a recent row so its wallet is
   *  reused verbatim (SessionAccessProfileEcho.profileRef). */
  accessProfileRef?: string
  /** Entry-picker "Browse all models…" row: opens the harness drill-down for a
   *  combo not in favorites/recent. */
  browse?: boolean
  /** The row opens the full mode/cwd/label/prompt chain unchanged. */
  configure?: boolean
  /** Set when this row spawns a saved user preset — see mapPresetQuickPickItems. */
  preset?: UserPreset
  /** Catalog route gateway (`route.route`, e.g. "openrouter") this row bills.
   *  Carried so the spawn sends an explicit `route.gateway` instead of letting
   *  the model fall back to the adapter's native provider — the daemon's
   *  serviceability guard 500s a gateway model spawned walletless. Absent for
   *  the manifest picker (mapSpawnQuickPickItems), which has no catalog route. */
  route?: string
  /** The auth profiles eligible to bill this route (`route.eligibleProfiles`).
   *  Empty means no connected wallet services it. The wizard attaches the sole
   *  profile silently, asks when several, and offers to connect one when none —
   *  so picking a model never dead-ends on the guard. */
  eligibleProfiles?: string[]
  /** `route.runnable` — whether this route can spawn as-is. A false row is
   *  still shown (so the missing model isn't a mystery) but routes to connect. */
  runnable?: boolean
}

/**
 * The collapsed spawn picker: every adapter's declared models grouped under
 * a provider heading (`vscode.QuickPickItemKind.Separator`) — the provider
 * is the heading, not a label prefix, because "which brain" (the model) and
 * "who serves it" (the adapter, shown in the row's description) are
 * different questions. A model whose manifest entry binds a `mode` (a
 * gateway model) carries that mode on the row, so picking it applies the
 * mode automatically instead of silently spawning in the adapter's default
 * (== native == wrong provider for a gateway id). A model with no stated
 * provider is grouped under its adapter's own name instead — an unstated
 * provider is never guessed. An adapter with no declared models gets a
 * single bare-slug row of its own (model omitted, adapter default applies)
 * instead of a custom row, since there is nothing to override; every other
 * model-declaring adapter's "type any id" row is collected under one
 * trailing custom-model section. A trailing Configure… row opens the full
 * chain unchanged. Adapter order matches mapAdapterQuickPickItems (ready
 * adapters first); group order follows first appearance in that order.
 */
export function mapSpawnQuickPickItems(adapters: SpawnAdapterInfo[]): SpawnQuickPickItem[] {
  const groups = new Map<string, { heading: string; rows: SpawnQuickPickItem[] }>()
  const customRows: SpawnQuickPickItem[] = []

  function groupFor(key: string, heading: string): { heading: string; rows: SpawnQuickPickItem[] } {
    const existing = groups.get(key)
    if (existing) return existing
    const created = { heading, rows: [] as SpawnQuickPickItem[] }
    groups.set(key, created)
    return created
  }

  for (const { adapter } of mapAdapterQuickPickItems(adapters)) {
    const description = adapter.hint ?? adapter.status ?? adapter.name
    const entries = modelEntriesOf(adapter)
    if (entries.length === 0) {
      groupFor(`adapter:${adapter.slug}`, adapter.slug).rows.push({ label: adapter.slug, description, adapter })
      continue
    }
    for (const entry of entries) {
      const key = entry.provider ?? `adapter:${adapter.slug}`
      groupFor(key, entry.provider ?? adapter.slug).rows.push({
        label: entry.id,
        description: adapter.slug,
        adapter,
        model: entry.id,
        ...(entry.mode ? { mode: entry.mode } : {}),
      })
    }
    customRows.push({ label: `${adapter.slug} · ${CUSTOM_MODEL_LABEL}`, description, adapter, custom: true })
  }

  const items: SpawnQuickPickItem[] = []
  for (const group of groups.values()) {
    items.push({ label: group.heading, kind: SEPARATOR_KIND })
    items.push(...group.rows)
  }
  if (customRows.length > 0) {
    items.push({ label: CUSTOM_MODEL_SECTION_LABEL, kind: SEPARATOR_KIND })
    items.push(...customRows)
  }
  items.push({ label: CONFIGURE_LABEL, configure: true })
  return items
}

// ── Catalog-based spawn picker (SPEC §5) ────────────────────────────────────

/** Bottom section heading for models with no connected wallet to bill them. */
export const NEEDS_PROFILE_SECTION_LABEL = "Needs a profile"

/**
 * The one route to represent a product in the collapsed spawn picker.
 *
 * A product is offered on many routes (native, openrouter, requesty, …) and
 * the old picker emitted a row for EVERY (product × route) pair — the same
 * model repeated once per gateway, most of them `runnable: false` "no
 * profile" rows for wallets the user never connected. That combinatorial
 * flood is the whole complaint this collapse fixes: one row per product, on
 * its best route. "Best" = runnable beats non-runnable (you can spawn it now),
 * then curated beats uncurated (the vendor's blessed path), then first-seen —
 * so a model you can run today surfaces on the route that actually bills.
 * Alternate routes aren't lost: the session's route chip switches gateway
 * after spawn (sessionConfig.logic.ts resolveRouteRows).
 */
export function pickPrimaryRoute(routes: CatalogRoute[]): CatalogRoute | undefined {
  const rank = (r: CatalogRoute): number => (r.runnable ? 0 : 2) + (r.curated ? 0 : 1)
  return routes
    .map((route, index) => ({ route, index }))
    .sort((a, b) => rank(a.route) - rank(b.route) || a.index - b.index)
    .map(({ route }) => route)[0]
}

/**
 * Build spawn picker items from the daemon's unified model catalog. ONE row
 * per product (see pickPrimaryRoute — routes are collapsed, not fanned out),
 * split into two sections: the models you can spawn right now, grouped under
 * their vendor heading, then a single deprioritized "Needs a profile" section
 * for products whose best route has no connected wallet — shown (never hidden:
 * the gap is named, SPEC §6 rule 5) but swept out of the way so the runnable
 * models read first. The first adapter in the route's `adapters` list is the
 * default harness; the row still carries model/mode/route/eligibleProfiles so
 * a non-runnable pick routes straight to the connect-a-profile flow.
 */
export function mapCatalogSpawnQuickPickItems(catalog: CatalogModelsResponse): SpawnQuickPickItem[] {
  const runnableByVendor: { vendor: string; rows: SpawnQuickPickItem[] }[] = []
  const needsProfile: SpawnQuickPickItem[] = []

  for (const vendor of catalog.vendors) {
    const runnableRows: SpawnQuickPickItem[] = []

    for (const product of vendor.products) {
      const route = pickPrimaryRoute(product.routes)
      if (!route) continue
      const defaultAdapter = route.adapters[0] ?? vendor.vendor
      const extraRoutes = product.routes.length - 1
      const row: SpawnQuickPickItem = {
        label: product.product,
        description: route.runnable
          ? `${defaultAdapter} · ${route.route}${extraRoutes > 0 ? ` · +${extraRoutes} more` : ""}`
          : `${defaultAdapter} · ${route.route} · no profile`,
        adapter: { slug: defaultAdapter, name: defaultAdapter } as SpawnAdapterInfo,
        model: route.ref,
        mode: route.adapterModes[0],
        route: route.route,
        eligibleProfiles: route.eligibleProfiles,
        runnable: route.runnable,
      }
      if (route.runnable) runnableRows.push(row)
      else needsProfile.push(row)
    }

    if (runnableRows.length > 0) runnableByVendor.push({ vendor: vendor.vendor, rows: runnableRows })
  }

  const items: SpawnQuickPickItem[] = []
  for (const { vendor, rows } of runnableByVendor) {
    items.push({ label: vendor, kind: SEPARATOR_KIND })
    items.push(...rows)
  }
  if (needsProfile.length > 0) {
    items.push({ label: NEEDS_PROFILE_SECTION_LABEL, kind: SEPARATOR_KIND })
    items.push(...needsProfile)
  }

  items.push({ label: CONFIGURE_LABEL, configure: true })
  return items
}

// ── Harness-first spawn picker (drill-down, not a pre-exploded flat list) ────

/** Entry-picker heading over the harness rows. */
export const HARNESSES_SECTION_LABEL = "Harnesses"

/**
 * The spawn entry picker: favorites (prepended by the caller) over one row
 * per installed harness — NOT the pre-exploded model catalog. The harness
 * (claude-code / hermes / codex / mastra-agent …) is agentproto's biggest
 * behavioral axis, and the same model served under N harnesses is exactly
 * what flooded the old flat list. Picking a harness here narrows to just that
 * harness's models (mapHarnessCatalogModelItems) — so "which model" is asked
 * against a short, relevant set instead of the whole cross-product. Ready
 * harnesses sort first (mapAdapterQuickPickItems); a trailing Configure… row
 * still opens the full cwd/label/orchestrator/permissions chain.
 */
export function mapHarnessEntryItems(adapters: SpawnAdapterInfo[]): SpawnQuickPickItem[] {
  const items: SpawnQuickPickItem[] = [{ label: HARNESSES_SECTION_LABEL, kind: SEPARATOR_KIND }]
  for (const { label, description, adapter } of mapAdapterQuickPickItems(adapters)) {
    items.push({ label, description, adapter, harness: true })
  }
  items.push({ label: CONFIGURE_LABEL, configure: true })
  return items
}

/**
 * Stage two of the harness-first flow: the models a chosen harness can serve,
 * from the unified catalog, filtered to routes whose `adapters` include that
 * harness. Same collapse/section rules as mapCatalogSpawnQuickPickItems — one
 * row per product on its best route (pickPrimaryRoute), runnable models grouped
 * by vendor first, non-runnable swept under "Needs a profile" — but scoped to
 * the harness, so the provider is the vendor·route in the row (the adapter is
 * fixed and no longer worth repeating). A trailing custom… row types any model
 * id for this harness; there's no Configure row here (Configure is its own
 * entry path). Empty of model rows when the catalog knows nothing this harness
 * serves — the caller then falls back to the manifest list.
 */
export function mapHarnessCatalogModelItems(
  catalog: CatalogModelsResponse,
  harness: string,
): SpawnQuickPickItem[] {
  const runnableByVendor: { vendor: string; rows: SpawnQuickPickItem[] }[] = []
  const needsProfile: SpawnQuickPickItem[] = []

  for (const vendor of catalog.vendors) {
    const rows: SpawnQuickPickItem[] = []
    for (const product of vendor.products) {
      const served = product.routes.filter(r => r.adapters.includes(harness))
      const route = pickPrimaryRoute(served)
      if (!route) continue
      const extraRoutes = served.length - 1
      const row: SpawnQuickPickItem = {
        label: product.product,
        description: route.runnable
          ? `${vendor.vendor} · ${route.route}${extraRoutes > 0 ? ` · +${extraRoutes} more` : ""}`
          : `${vendor.vendor} · ${route.route} · no profile`,
        adapter: { slug: harness, name: harness } as SpawnAdapterInfo,
        model: route.ref,
        mode: route.adapterModes[0],
        route: route.route,
        eligibleProfiles: route.eligibleProfiles,
        runnable: route.runnable,
      }
      if (route.runnable) rows.push(row)
      else needsProfile.push(row)
    }
    if (rows.length > 0) runnableByVendor.push({ vendor: vendor.vendor, rows })
  }

  const items: SpawnQuickPickItem[] = []
  for (const { vendor, rows } of runnableByVendor) {
    items.push({ label: vendor, kind: SEPARATOR_KIND })
    items.push(...rows)
  }
  if (needsProfile.length > 0) {
    items.push({ label: NEEDS_PROFILE_SECTION_LABEL, kind: SEPARATOR_KIND })
    items.push(...needsProfile)
  }
  items.push({ label: `${harness} · ${CUSTOM_MODEL_LABEL}`, adapter: { slug: harness, name: harness } as SpawnAdapterInfo, custom: true })
  return items
}

/**
 * Manifest fallback for stage two on a daemon with no `/catalog/models`:
 * the harness's own declared models grouped by provider heading (unstated
 * provider under the harness's own name), plus a trailing custom… row. No
 * route/runnable info exists here, so every row is a plain native pick.
 */
export function mapHarnessManifestModelItems(adapter: SpawnAdapterInfo): SpawnQuickPickItem[] {
  const groups = new Map<string, SpawnQuickPickItem[]>()
  for (const entry of modelEntriesOf(adapter)) {
    const key = entry.provider ?? adapter.slug
    const rows = groups.get(key) ?? (groups.set(key, []), groups.get(key)!)
    rows.push({
      label: entry.id,
      adapter,
      model: entry.id,
      ...(entry.mode ? { mode: entry.mode } : {}),
    })
  }
  const items: SpawnQuickPickItem[] = []
  for (const [heading, rows] of groups) {
    items.push({ label: heading, kind: SEPARATOR_KIND })
    items.push(...rows)
  }
  items.push({ label: `${adapter.slug} · ${CUSTOM_MODEL_LABEL}`, adapter, custom: true })
  return items
}

// ── Quick-spawn entry: favorites + latest-used, one click each ───────────────

/** Entry-picker row that reopens the full harness → model drill-down. */
export const BROWSE_ALL_LABEL = "$(list-tree) Browse all models…"
const RECENT_HEADING = "Recent"
const RECENT_ICON = "$(history)"

/** A distinct past spawn combo, newest-first, for the "latest used" rows. */
export interface RecentSpawn {
  adapter: string
  model?: string
  mode?: string
  /** route.gateway of the past session — the billing rail to reuse. */
  gateway?: string
  accessProfileRef?: string
  workspaceSlug?: string
  startedAtMs: number
}

/**
 * Collapse a session list into the distinct spawn combos to offer as one-click
 * "recent" rows. Newest first, deduped by (adapter · model · gateway) so the
 * same combo run ten times is one row, capped at `limit`. Only agent-cli
 * sessions with a known adapter qualify — a bare terminal has no combo to
 * replay. Pure: `startedAt` is parsed here, no ambient clock.
 */
export function deriveRecentSpawns(sessions: readonly SessionDescriptor[], limit = 6): RecentSpawn[] {
  const seen = new Set<string>()
  const out: RecentSpawn[] = []
  const ranked = sessions
    .filter(s => s.kind === "agent-cli" && !!s.adapterSlug)
    .map(s => ({ s, at: Date.parse(s.startedAt) }))
    .filter(({ at }) => !Number.isNaN(at))
    .sort((a, b) => b.at - a.at)
  for (const { s, at } of ranked) {
    const key = `${s.adapterSlug}|${s.model ?? ""}|${s.route?.gateway ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      adapter: s.adapterSlug!,
      model: s.model,
      mode: s.mode,
      gateway: s.route?.gateway,
      accessProfileRef: s.accessProfile?.profileRef,
      workspaceSlug: s.workspaceSlug || undefined,
      startedAtMs: at,
    })
    if (out.length >= limit) break
  }
  return out
}

/** Coarse "how long ago", pure given `nowMs`. */
export function relativeTime(thenMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000))
  if (s < 45) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/**
 * The quick-spawn entry picker: tall, one-click rows for the combos you
 * actually reach for — your saved favorites, then your latest-used combos —
 * each carrying the WHOLE spawn (harness · model · provider · wallet) in its
 * `detail` line so a single Enter spawns it, no drill-down. A favorite row is
 * a saved preset (daemon-expanded); a recent row replays a past session's exact
 * adapter/model/route/wallet. Trailing "Browse all models…" opens the harness
 * drill-down for anything not listed, and "Configure…" the full chain. Returns
 * an empty combo list (only the two trailing rows) when there are neither
 * favorites nor recent — the caller then falls back to the harness picker so a
 * brand-new user still has a first step.
 */
export function mapQuickSpawnItems(
  presets: UserPreset[],
  recent: RecentSpawn[],
  nowMs: number,
): SpawnQuickPickItem[] {
  const items: SpawnQuickPickItem[] = []

  if (presets.length > 0) {
    items.push({ label: FAVORITES_HEADING, kind: SEPARATOR_KIND })
    for (const preset of presets) {
      const combo = [preset.adapter ?? preset.harness, preset.model].filter(Boolean).join(" · ")
      items.push({
        label: `${FAVORITE_ICON} ${preset.label}`,
        detail: combo || "saved favorite",
        preset,
      })
    }
  }

  if (recent.length > 0) {
    items.push({ label: RECENT_HEADING, kind: SEPARATOR_KIND })
    for (const r of recent) {
      const detail = [
        r.adapter,
        r.gateway,
        r.workspaceSlug,
        relativeTime(r.startedAtMs, nowMs),
      ]
        .filter(Boolean)
        .join(" · ")
      items.push({
        label: `${RECENT_ICON} ${r.model ?? r.adapter}`,
        detail,
        adapter: { slug: r.adapter, name: r.adapter } as SpawnAdapterInfo,
        recent: true,
        ...(r.model ? { model: r.model } : {}),
        ...(r.mode ? { mode: r.mode } : {}),
        ...(r.gateway ? { route: r.gateway } : {}),
        ...(r.accessProfileRef ? { accessProfileRef: r.accessProfileRef } : {}),
      })
    }
  }

  items.push({ label: BROWSE_ALL_LABEL, browse: true })
  items.push({ label: CONFIGURE_LABEL, configure: true })
  return items
}

export interface ProviderQuickPickItem {
  label: string
  description?: string
  /** Filter key for the model step — undefined means "this adapter's own
   *  unstated-provider models" (there's no real provider to narrow by, so
   *  the row is labelled with the adapter's name instead of a provider id,
   *  mirroring mapSpawnQuickPickItems' own-name grouping). */
  provider?: string
}

/**
 * Provider picker for the Configure… chain — the step the plan adds ahead
 * of model selection. Options are the distinct `provider` values across the
 * adapter's declared models (unstated entries collapse to one "adapter's
 * own name" option), in first-appearance order. Empty when the adapter
 * declares no models at all, so the caller can skip straight to the
 * existing (custom-only) model step.
 */
export function mapProviderQuickPickItems(adapter: SpawnAdapterInfo): ProviderQuickPickItem[] {
  const seen = new Map<string | undefined, ProviderQuickPickItem>()
  for (const entry of modelEntriesOf(adapter)) {
    const key = entry.provider
    if (!seen.has(key)) {
      seen.set(key, { label: key ?? adapter.slug, provider: key })
    }
  }
  return [...seen.values()]
}

/** Mirrors vscode's `WorkspaceFolder` — only the fields this module needs. */
export interface WorkspaceFolderLike {
  uri: { fsPath: string }
  name: string
}

export interface CwdResolutionInput {
  folders: readonly WorkspaceFolderLike[]
  /** fsPath of the active editor's document, when there is one. */
  activeFilePath?: string
}

export type CwdResolution =
  | { kind: "resolved"; cwd: string }
  | { kind: "ambiguous"; candidates: WorkspaceFolderLike[] }
  | { kind: "none" }

/**
 * Same longest-prefix, segment-boundary rule as
 * services/workspaces.logic.ts's isUnder — duplicated locally because it
 * operates over WorkspaceFolderLike (uri.fsPath) rather than WorkspaceEntry
 * (path), and a folder carries no slug to route through the shared helper.
 */
function normalizePath(p: string): string {
  const trimmed = p.replace(/\/+$/, "")
  return trimmed === "" ? "/" : trimmed
}

function isUnderFolder(filePath: string, folderPath: string): boolean {
  const f = normalizePath(filePath)
  const root = normalizePath(folderPath)
  if (f === root) return true
  return f.startsWith(root === "/" ? "/" : `${root}/`)
}

function longestPrefixFolder(
  folders: readonly WorkspaceFolderLike[],
  filePath: string,
): WorkspaceFolderLike | undefined {
  const matches = folders
    .filter(f => isUnderFolder(filePath, f.uri.fsPath))
    .sort((a, b) => normalizePath(b.uri.fsPath).length - normalizePath(a.uri.fsPath).length)
  return matches[0]
}

/**
 * Default-cwd ladder, most-specific first:
 *   1. the active editor's file → the folder containing it (longest-prefix
 *      match) → resolved.
 *   2. exactly one workspace folder → resolved.
 *   3. multiple folders and no active editor inside any of them → ambiguous
 *      (caller shows a folder quick-pick).
 *   4. no folders at all → none (caller falls back to a free-text input box).
 * A file outside every folder (e.g. a /tmp scratch buffer) falls through to
 * step 2/3 rather than resolving to the file's own directory.
 */
export function resolveDefaultCwd(input: CwdResolutionInput): CwdResolution {
  const { folders, activeFilePath } = input
  if (activeFilePath) {
    const containing = longestPrefixFolder(folders, activeFilePath)
    if (containing) return { kind: "resolved", cwd: containing.uri.fsPath }
  }
  if (folders.length === 1) {
    const sole = folders[0]
    if (sole) return { kind: "resolved", cwd: sole.uri.fsPath }
  }
  if (folders.length > 1) return { kind: "ambiguous", candidates: [...folders] }
  return { kind: "none" }
}

export interface FolderQuickPickItem {
  label: string
  description?: string
  folder: WorkspaceFolderLike
}

/** Folder disambiguation picker, shown only when resolveDefaultCwd reports "ambiguous". */
export function mapFolderQuickPickItems(folders: readonly WorkspaceFolderLike[]): FolderQuickPickItem[] {
  return folders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f }))
}

/**
 * cwd → registered workspace slug, via the daemon's own longest-prefix rule
 * (services/workspaces.logic.ts). Undefined cwd or no registered match →
 * undefined, so the daemon falls back to its own inference rather than
 * receiving a wrong slug.
 */
export function resolveWorkspaceSlug(config: WorkspacesConfig, cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  return findWorkspaceByPath(config, cwd)?.slug
}

export interface SpawnWizardAnswers {
  adapter: string
  /** Saved user preset selected before the custom axis picker. The daemon
   * expands it; fields selected by the wizard remain higher precedence. */
  presetId?: string
  model?: string
  mode?: string
  /** Explicit routing rail carried from the catalog row so a gateway model
   *  bills its real gateway (see SpawnQuickPickItem.route). */
  route?: RouteSpec
  /** The named auth profile to bill — resolved from the route's eligible
   *  profiles (attached silently when unambiguous, picked when several). */
  accessProfileRef?: string
  cwd?: string
  workspaceSlug?: string
  label?: string
  prompt?: string
  /** Park each tool-permission request for a human decision — see PermissionQuickPickItem. */
  permissionHold?: boolean
  /** Give this session a scoped gateway so ITS spawns are attributed to it — see OrchestratorQuickPickItem. */
  orchestrator?: boolean
}

/**
 * Orchestrator picker — the switch that makes subagents visible.
 *
 * The sessions tree already nests children under the session that spawned
 * them, at any depth, and keeps a subtree with its root across the recency
 * divider. It has simply never had anything to nest: the daemon attributes
 * `parentSessionId` from `callerScope?.ownerSessionId`, and `callerScope`
 * exists only on the scoped sub-gateway minted for an `orchestrator: true`
 * spawn (session-spawn.ts: "no callerScope is a root: depth 0, no parent, no
 * caps"). Every spawn through the root `/mcp` is a root. `SpawnAgentOptions`
 * has carried the `orchestrator` field all along; the wizard just never sent
 * it, so an orchestrator was unspawnable from the editor.
 *
 * That the daemon needs a scoped gateway to attribute is not arbitrary: an
 * MCP client on the root `/mcp` is anonymous, and the daemon cannot record a
 * parent it cannot identify. The token IS the identity.
 *
 * Deliberately a per-spawn step and NOT a setting, unlike holdPermissions.
 * "Approve my tools" is a standing preference; "this agent supervises others"
 * is a fact about one job. A default-on setting would also silently subject
 * every spawn to the depth cap, the child quota and subtree-only
 * list/kill — see the description below, which says so up front.
 */
export interface OrchestratorQuickPickItem {
  label: string
  description?: string
  orchestrator: boolean
}

export function mapOrchestratorQuickPickItems(): OrchestratorQuickPickItem[] {
  return [
    {
      label: "Standalone",
      description: "anything it spawns is listed as its own top-level session",
      orchestrator: false,
    },
    {
      label: "Orchestrator",
      description: "its subagents nest under it — adds depth/child caps and subtree-only list & stop",
      orchestrator: true,
    },
  ]
}

/**
 * Permission picker. The whole approve/deny chain already exists — the
 * permissions inbox, the badge, the toast with Approve/Deny/Show, the
 * `POST /permissions/:id` round-trip — and none of it could ever fire,
 * because a session only PARKS a `session/request_permission` when it was
 * spawned with `permissionHold` (see packages/acp's client: hold intercepts
 * before the auto-answer handler). The extension never sent the flag, so the
 * adapter auto-answered every request and `GET /permissions` stayed `[]`
 * forever. This picker is the missing switch, not a new feature.
 */
export interface PermissionQuickPickItem {
  label: string
  description?: string
  hold: boolean
}

export function mapPermissionQuickPickItems(current: boolean): PermissionQuickPickItem[] {
  const items: PermissionQuickPickItem[] = [
    {
      label: "Unattended",
      description: "the agent decides for itself — nothing to approve",
      hold: false,
    },
    {
      label: "Ask me before each tool",
      description: "parks every request in the Permissions view and notifies you",
      hold: true,
    },
  ]
  // Lead with whatever the setting already says, so Enter re-picks the
  // current default instead of silently flipping it.
  return current ? [items[1]!, items[0]!] : items
}

/**
 * placeHolder for the collapsed spawn picker. The resolved default must be
 * visible up front — autodetection that silently applies a cwd/workspace is
 * the exact complaint this wizard exists to fix, and a spawn that will stop
 * and ask permission for every tool is exactly as surprising after the fact.
 */
export function buildSpawnPlaceHolder(
  config: WorkspacesConfig,
  cwd: string | undefined,
  permissionHold = false,
): string {
  const hold = permissionHold ? " · asking before each tool" : ""
  if (!cwd) {
    return `No workspace folder open — select adapter · model${hold} (Configure… to set a working directory)`
  }
  const slug = resolveWorkspaceSlug(config, cwd)
  const where = slug ? `${workspaceLabel(config, slug)} (${cwd})` : cwd
  return `Spawning in ${where} — select adapter · model${hold}`
}

/** Assemble the POST /sessions/agent body, omitting unset optional fields. */
export function assembleSpawnOptions(answers: SpawnWizardAnswers): SpawnAgentOptions {
  const opts: SpawnAgentOptions = { adapter: answers.adapter }
  if (answers.model) opts.model = answers.model
  if (answers.mode) opts.mode = answers.mode
  if (answers.cwd) opts.cwd = answers.cwd
  if (answers.workspaceSlug) opts.workspaceSlug = answers.workspaceSlug
  if (answers.label) opts.label = answers.label
  if (answers.prompt) opts.prompt = answers.prompt
  if (answers.permissionHold) opts.permissionHold = true
  // Both flags are sent ONLY when true: false is the daemon's own default, so
  // saying it adds nothing and asserting it would be a claim we don't need to
  // make.
  if (answers.orchestrator) opts.orchestrator = true
  if (answers.presetId) opts.presetId = answers.presetId
  if (answers.route) opts.route = answers.route
  if (answers.accessProfileRef) opts.access = { profileRef: answers.accessProfileRef }
  return opts
}

/**
 * How a catalog row's route resolves to a billable wallet, given the profiles
 * eligible to service it and whether the route is runnable as-is. Pure so the
 * wizard's branching is unit-tested without driving quick-picks:
 *
 *   - `attach`  — exactly one eligible profile: bind it silently, no prompt.
 *   - `pick`    — several eligible profiles: the caller shows a wallet picker.
 *   - `default` — none eligible but the route is runnable: the daemon resolves
 *                 its own default wallet (the Anthropic subscription path), so
 *                 send no `access` and let it — attaching nothing is correct,
 *                 not a gap.
 *   - `connect` — none eligible and NOT runnable: no wallet can bill this model
 *                 yet, so spawning would 500 the serviceability guard. The
 *                 caller offers to connect a profile instead of dead-ending.
 */
export type ProfileChoice =
  | { kind: "attach"; profileRef: string }
  | { kind: "pick"; options: string[] }
  | { kind: "default" }
  | { kind: "connect" }

export function classifyProfileChoice(
  eligibleProfiles: string[] | undefined,
  runnable: boolean | undefined,
): ProfileChoice {
  const eligible = eligibleProfiles ?? []
  if (eligible.length === 1) return { kind: "attach", profileRef: eligible[0]! }
  if (eligible.length > 1) return { kind: "pick", options: eligible }
  return runnable ? { kind: "default" } : { kind: "connect" }
}
