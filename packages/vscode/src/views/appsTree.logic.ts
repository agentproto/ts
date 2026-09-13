/**
 * Pure rendering/grouping logic for the Apps tree view — no vscode import
 * so it's unit-testable under plain vitest.
 *
 * The tree mirrors the daemon's installed-app registry (`app_list`) in
 * full: every installed app is listed, grouped by the `category` the
 * `app_catalog` file assigns it (`app` | `team` | …, falling back to
 * "app" when the catalog doesn't know the app). Each app expands to the
 * agents and workflows it bundles.
 */

import type { AppCatalogEntry, InstalledAppInfo, InstalledAppRef } from "../client/types.js"

/** Category assumed for an app the catalog file doesn't classify. */
export const DEFAULT_APP_CATEGORY = "app"

/** An app row. Kept as its own shape (not just the `kind: "app"` union
 *  member) because the open-panel / open-in-browser commands take it. */
export interface AppNode {
  app: InstalledAppInfo
}

export interface CategoryGroup {
  category: string
  apps: InstalledAppInfo[]
}

export type AppsTreeNode =
  | { kind: "category"; category: string; apps: InstalledAppInfo[] }
  | { kind: "app"; app: InstalledAppInfo }
  | { kind: "agent"; app: InstalledAppInfo; ref: InstalledAppRef }
  | { kind: "workflow"; app: InstalledAppInfo; ref: InstalledAppRef }
  | { kind: "empty" }

export type AppChildNode = Extract<AppsTreeNode, { kind: "agent" | "workflow" }>

/** Apps that ship a UI panel — the only ones the open-panel /
 *  open-in-browser commands can act on. */
export function appsWithUi(apps: InstalledAppInfo[]): InstalledAppInfo[] {
  return apps.filter(app => app.ui !== undefined)
}

/**
 * Stamp each installed app with the `category` its `app_catalog` entry
 * declares. An app's own `category` (if a future daemon puts one on the
 * `app_list` record) wins; apps the catalog doesn't list are returned as-is.
 */
export function withCatalogCategories(
  apps: InstalledAppInfo[],
  catalog: AppCatalogEntry[],
): InstalledAppInfo[] {
  const byId = new Map<string, string>()
  for (const entry of catalog) {
    const category = entry.category?.trim()
    if (category) byId.set(entry.appId, category)
  }
  return apps.map(app => {
    if (app.category?.trim()) return app
    const category = byId.get(app.appId)
    return category ? { ...app, category } : app
  })
}

/** Effective category of an app: its own, else `DEFAULT_APP_CATEGORY`. */
export function appCategory(app: InstalledAppInfo): string {
  return app.category?.trim().toLowerCase() || DEFAULT_APP_CATEGORY
}

const CATEGORY_LABELS: Record<string, string> = {
  app: "Apps",
  team: "Teams",
}

/** Group-row label for a category: the known plurals, else the raw
 *  category with its first letter capitalized. */
export function categoryLabel(category: string): string {
  const known = CATEGORY_LABELS[category]
  if (known) return known
  return category.charAt(0).toUpperCase() + category.slice(1)
}

/** Fixed order for the well-known categories; anything else follows
 *  alphabetically so a new catalog category never lands in a random slot. */
const CATEGORY_ORDER = ["app", "team"]

function compareCategories(a: string, b: string): number {
  const ia = CATEGORY_ORDER.indexOf(a)
  const ib = CATEGORY_ORDER.indexOf(b)
  if (ia !== -1 || ib !== -1) {
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  }
  return a.localeCompare(b)
}

/**
 * Bucket apps by `appCategory`. Groups come out in `CATEGORY_ORDER` then
 * alphabetical; apps within a group are sorted by their row label so the
 * tree is stable across refreshes regardless of install order.
 */
export function groupAppsByCategory(apps: InstalledAppInfo[]): CategoryGroup[] {
  const buckets = new Map<string, InstalledAppInfo[]>()
  for (const app of apps) {
    const category = appCategory(app)
    const bucket = buckets.get(category)
    if (bucket) bucket.push(app)
    else buckets.set(category, [app])
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => compareCategories(a, b))
    .map(([category, groupApps]) => ({
      category,
      apps: [...groupApps].sort((a, b) => appLabel(a).localeCompare(appLabel(b))),
    }))
}

/** Row label: the UI's declared title, then the app's name, then its id. */
export function appLabel(app: InstalledAppInfo): string {
  return app.ui?.title?.trim() || app.name?.trim() || app.appId
}

/** Row description: the UI's description, then the app's own. */
export function appDescription(app: InstalledAppInfo): string {
  return app.ui?.description?.trim() || app.description?.trim() || ""
}

/** Group-row description: how many apps it holds. */
export function categoryDescription(group: CategoryGroup): string {
  return `${group.apps.length}`
}

/** Tooltip lines for an app row: identity, install dir, and what it
 *  bundles — the counts matter most for agent/workflow-only apps, whose
 *  row otherwise looks inert. */
export function appTooltip(app: InstalledAppInfo): string {
  const agents = app.agents?.length ?? 0
  const workflows = app.workflows?.length ?? 0
  const lines = [app.version ? `${app.appId} v${app.version}` : app.appId]
  if (app.dir) lines.push(app.dir)
  lines.push(
    `${agents} ${agents === 1 ? "agent" : "agents"} · ${workflows} ${workflows === 1 ? "workflow" : "workflows"}` +
      (app.ui ? " · UI panel" : ""),
  )
  return lines.join("\n")
}

/** Context value driving the app row's menu: only `app` (ships a UI) gets
 *  the open-panel / open-in-browser actions. */
export function appContextValue(app: InstalledAppInfo): "app" | "app-no-ui" {
  return app.ui ? "app" : "app-no-ui"
}

/** Child rows of an app: its agents, then its workflows. */
export function appChildren(app: InstalledAppInfo): AppChildNode[] {
  return [
    ...(app.agents ?? []).map(ref => ({ kind: "agent" as const, app, ref })),
    ...(app.workflows ?? []).map(ref => ({ kind: "workflow" as const, app, ref })),
  ]
}

export function appHasChildren(app: InstalledAppInfo): boolean {
  return (app.agents?.length ?? 0) + (app.workflows?.length ?? 0) > 0
}

/** Absolute path of the app's root manifest (`<dir>/.agentproto/APP.md`,
 *  where `@agentproto/app-kit`'s `emit` writes it). Undefined when the
 *  registry record carries no `dir` (older daemon). */
export function appManifestPath(app: InstalledAppInfo): string | undefined {
  const dir = app.dir?.trim()
  if (!dir) return undefined
  return `${dir.replace(/[\\/]+$/, "")}/.agentproto/APP.md`
}

/** The markdown manifest a row stands for — APP.md for an app, the
 *  emitted AGENT.md / WORKFLOW.md for its children. */
export function nodeManifestPath(node: AppsTreeNode): string | undefined {
  switch (node.kind) {
    case "app":
      return appManifestPath(node.app)
    case "agent":
    case "workflow":
      return node.ref.path
    default:
      return undefined
  }
}

/** Child-row label: the agent / workflow id as declared in the manifest. */
export function refLabel(ref: InstalledAppRef): string {
  return ref.id
}

/** Tab name for a manifest opened as a read-only document — app-scoped so
 *  two apps' `AGENT.md` don't collide, and ending in `.md` so the editor
 *  picks markdown highlighting. */
export function manifestDocumentName(node: AppsTreeNode): string {
  switch (node.kind) {
    case "app":
      return `${node.app.appId}/APP.md`
    case "agent":
      return `${node.app.appId}/agents/${node.ref.id}/AGENT.md`
    case "workflow":
      return `${node.app.appId}/workflows/${node.ref.id}/WORKFLOW.md`
    default:
      return "APP.md"
  }
}

export const EMPTY_APPS_LABEL = "No apps installed"
