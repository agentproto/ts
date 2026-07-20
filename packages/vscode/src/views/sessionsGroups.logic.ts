/**
 * Pure workspace-grouping logic for the sessions tree — NO vscode import, so
 * it's unit-testable under plain vitest (sessionsTree.ts wraps the result
 * into vscode.TreeItem, same split as sessionsTree.logic.ts).
 *
 * Design (decided with Jeremy 2026-07-18, PLAN.md "PR B"): the tree is
 * MOSTLY FLAT, grouped by registered agentproto workspace — not by VS Code's
 * open folders. Top level = one GroupNode per registered workspace (from
 * `DaemonClient.listWorkspaces()`), sessions land in a group via the
 * existing cwd→longest-prefix join (`findWorkspaceByPath`, NOT the
 * unreliable per-session `workspaceSlug` — see workspaces.logic.ts's own
 * doc for why). Inside a group, the existing 24h-divider + parentSessionId
 * nesting is reused unchanged via `buildSessionRows`.
 *
 * `buildSessionsRoots` is the single entry point sessionsTree.ts calls: it
 * decides flat vs. grouped from the `groupByWorkspace` setting, so the
 * toggle itself is a pure, testable decision rather than an if/else split
 * across the provider.
 */

import type { SessionDescriptor, WorkspacesConfig } from "../client/types.js"
import { findWorkspaceByPath } from "../services/workspaces.logic.js"
import { buildSessionRows, isSeparatorNode, type TreeNode } from "./sessionsTree.logic.js"

/** Bucket id for sessions whose cwd matches no registered workspace. Distinct
 *  from any real slug ("default" is also the CLI's fallback active-workspace
 *  name, but this bucket is purely a rendering concern — it never round-trips
 *  through the daemon). */
export const UNASSIGNED_SLUG = "default"
export const UNASSIGNED_LABEL = "default (unassigned)"

/** Stable TreeItem id for a workspace's group row. */
export function groupNodeId(slug: string): string {
  return `workspace-group:${slug}`
}

export interface GroupNode {
  kind: "group"
  id: string
  slug: string
  label: string
  /** Total sessions (roots + nested children) landed in this group. */
  count: number
  /** True when this group matches an open VS Code folder — sorted first, expanded by default. */
  isOpen: boolean
  children: TreeNode[]
}

/** The "Create workspace here" inline row — shown per open VS Code folder
 *  that resolves to no registered workspace. */
export interface CtaNode {
  kind: "cta"
  id: string
  label: string
  folderPath: string
  suggestedSlug: string
}

export type RootNode = GroupNode | CtaNode | TreeNode

export function isGroupNode(value: unknown): value is GroupNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === "group"
  )
}

export function isCtaNode(value: unknown): value is CtaNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === "cta"
  )
}

/**
 * Mirrors `@agentproto/runtime` workspaces-config.ts `sanitizeSlug`
 * byte-for-byte (lowercase, `[a-z0-9_-]` only, collapsed, trimmed, capped at
 * 64 chars, "workspace" fallback). Duplicated rather than imported: the
 * extension bundle deliberately never pulls in the runtime package (it talks
 * to the daemon over HTTP only). Keep in sync by hand if the daemon's rule
 * changes.
 */
export function sanitizeWorkspaceSlug(input: string): string {
  const trimmed = input.trim().toLowerCase()
  const cleaned = trimmed
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  return cleaned || "workspace"
}

/** Last path segment of a `/`-separated absolute path (fsPath convention
 *  used throughout this codebase — see workspaces.logic.ts's normalizePath). */
function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "")
  const idx = trimmed.lastIndexOf("/")
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/**
 * Partition sessions by their cwd's registered workspace (longest-prefix
 * match), the same rule `workspaceLabelFor` uses for a single session. A
 * session with no cwd, or a cwd matching no registered workspace, lands in
 * `unassigned` rather than being dropped.
 *
 * Fallback: when cwd yields no match, we trust the session's `workspaceSlug`
 * (unless it is the daemon's generic "default"). This fixes the common case
 * where a session spawned from a symlinked or containerised path resolves to
 * nothing by cwd but still carries the correct slug from its spawner.
 */
export function partitionSessionsByWorkspace(
  sessions: readonly SessionDescriptor[],
  config: WorkspacesConfig,
): { bySlug: Map<string, SessionDescriptor[]>; unassigned: SessionDescriptor[] } {
  const bySlug = new Map<string, SessionDescriptor[]>()
  const unassigned: SessionDescriptor[] = []
  for (const session of sessions) {
    let entry = session.cwd ? findWorkspaceByPath(config, session.cwd) : undefined
    if (!entry && session.workspaceSlug && session.workspaceSlug !== "default") {
      entry = config.workspaces.find(w => w.slug === session.workspaceSlug)
    }
    if (!entry) {
      unassigned.push(session)
      continue
    }
    const bucket = bySlug.get(entry.slug)
    if (bucket) bucket.push(session)
    else bySlug.set(entry.slug, [session])
  }
  return { bySlug, unassigned }
}

/** Registered-workspace slugs matching any of the given open folder paths
 *  (VS Code's `workspaceFolders`, not the daemon's `workspaceSlug`). */
export function resolveOpenWorkspaceSlugs(
  config: WorkspacesConfig,
  openFolderPaths: readonly string[],
): Set<string> {
  const slugs = new Set<string>()
  for (const path of openFolderPaths) {
    const entry = findWorkspaceByPath(config, path)
    if (entry) slugs.add(entry.slug)
  }
  return slugs
}

/**
 * "Create workspace here" CTA rows — one per open folder that resolves to NO
 * registered workspace, deduplicated by path. Empty when every open folder
 * already has a workspace, or none are open.
 */
export function buildCreateWorkspaceCtas(
  config: WorkspacesConfig,
  openFolderPaths: readonly string[],
): CtaNode[] {
  const seen = new Set<string>()
  const ctas: CtaNode[] = []
  for (const path of openFolderPaths) {
    if (seen.has(path)) continue
    seen.add(path)
    if (findWorkspaceByPath(config, path)) continue
    const name = basenameOf(path) || path
    ctas.push({
      kind: "cta",
      id: `workspace-cta:${path}`,
      label: `Create workspace here (${name})`,
      folderPath: path,
      suggestedSlug: sanitizeWorkspaceSlug(name),
    })
  }
  return ctas
}

/** `"N session" | "N sessions"` for a group row's description. */
export function groupDescriptionFor(count: number): string {
  return `${count} session${count === 1 ? "" : "s"}`
}

export interface BuildWorkspaceGroupsOptions {
  /** Drop groups with zero sessions — the active-filter behavior: a filter
   *  already excludes non-matching sessions from `sessions`, so an empty
   *  group at that point is either genuinely empty or filtered-out, and
   *  either way has nothing to show. Off (default) shows every registered
   *  workspace regardless of session count — "mostly flat" means the
   *  workspace list itself is always visible. */
  hideEmpty?: boolean
}

/**
 * One GroupNode per registered workspace, plus a trailing "default
 * (unassigned)" group when any session matched none. Groups matching an open
 * VS Code folder sort first (each `isOpen: true`); the rest — and always the
 * unassigned group, last — sort alphabetically by label for a stable order.
 * Each group's children reuse `buildSessionRows` unchanged (24h divider +
 * parentSessionId nesting), scoped to that group's own session bucket.
 */
export function buildWorkspaceGroups(
  sessions: readonly SessionDescriptor[],
  config: WorkspacesConfig,
  openFolderPaths: readonly string[],
  now: number,
  opts: BuildWorkspaceGroupsOptions = {},
): GroupNode[] {
  const { bySlug, unassigned } = partitionSessionsByWorkspace(sessions, config)
  const openSlugs = resolveOpenWorkspaceSlugs(config, openFolderPaths)

  let registered: GroupNode[] = config.workspaces.map(entry => {
    const bucket = bySlug.get(entry.slug) ?? []
    return {
      kind: "group",
      id: groupNodeId(entry.slug),
      slug: entry.slug,
      label: entry.label ?? entry.slug,
      count: bucket.length,
      isOpen: openSlugs.has(entry.slug),
      children: buildSessionRows(bucket, now),
    }
  })

  if (opts.hideEmpty) registered = registered.filter(g => g.count > 0)

  const open = registered.filter(g => g.isOpen).sort((a, b) => a.label.localeCompare(b.label))
  const rest = registered.filter(g => !g.isOpen).sort((a, b) => a.label.localeCompare(b.label))
  const groups = [...open, ...rest]

  if (unassigned.length > 0) {
    groups.push({
      kind: "group",
      id: groupNodeId(UNASSIGNED_SLUG),
      slug: UNASSIGNED_SLUG,
      label: UNASSIGNED_LABEL,
      count: unassigned.length,
      isOpen: false,
      children: buildSessionRows(unassigned, now),
    })
  }

  return groups
}

export interface BuildSessionsRootsOptions {
  groupByWorkspace: boolean
  /** Whether the sessions passed in already went through an active filter —
   *  see BuildWorkspaceGroupsOptions.hideEmpty. */
  filterActive: boolean
}

/**
 * The tree's single top-level entry point. `groupByWorkspace: false` is
 * byte-identical to today's flat list (`buildSessionRows`, no groups, no
 * CTA); `true` prepends any "Create workspace here" rows ahead of the
 * workspace groups. Kept here (not in the provider) so the flat↔grouped
 * decision is itself a pure, tested function.
 */
export function buildSessionsRoots(
  sessions: readonly SessionDescriptor[],
  config: WorkspacesConfig,
  openFolderPaths: readonly string[],
  now: number,
  opts: BuildSessionsRootsOptions,
): RootNode[] {
  if (!opts.groupByWorkspace) return buildSessionRows(sessions, now)
  const ctas: RootNode[] = buildCreateWorkspaceCtas(config, openFolderPaths)
  const groups: RootNode[] = buildWorkspaceGroups(sessions, config, openFolderPaths, now, {
    hideEmpty: opts.filterActive,
  })
  return [...ctas, ...groups]
}

/** Every session id nested (at any depth) under a GroupNode's children — the
 *  reverse index sessionsTree.ts needs so `getParent` can answer "which
 *  group is this session's tree.reveal() root". `isSeparatorNode` guards the
 *  one non-session member of TreeNode. */
export function collectGroupMembership(groups: readonly GroupNode[]): Map<string, GroupNode> {
  const membership = new Map<string, GroupNode>()
  const visit = (group: GroupNode, nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      if (isSeparatorNode(node)) continue
      membership.set(node.session.id, group)
      visit(group, node.children)
    }
  }
  for (const group of groups) visit(group, group.children)
  return membership
}
