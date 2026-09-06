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
import {
  buildSessionRows,
  isSeparatorNode,
  STATUS_CATEGORY_ORDER,
  statusCategoryFor,
  statusCategoryLabel,
  type StatusCategory,
  type TreeNode,
} from "./sessionsTree.logic.js"

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
  /** Which dimension this group buckets by — drives the tree icon +
   *  contextValue in sessionsTree.ts. Absent ⇒ "workspace" (back-compat). */
  variant?: "workspace" | "origin" | "status"
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

/** Bucket id for a root whose descriptor carries no `origin`. */
export const UNKNOWN_ORIGIN_SLUG = "unknown"

/** Friendly display labels for the origins the daemon stamps (see the runtime
 *  `origin` field). An origin not in this table renders under its raw slug —
 *  new sources show up readably without a code change here. */
const ORIGIN_LABELS: Record<string, string> = {
  "claude-code": "Claude Code (desktop)",
  vscode: "VS Code extension",
  cron: "Cron",
  codex: "Codex",
  cowork: "Cowork",
  gate: "Automated gate reviews",
  [UNKNOWN_ORIGIN_SLUG]: "Unknown source",
}

export function originLabelFor(origin: string): string {
  return ORIGIN_LABELS[origin] ?? origin
}

/**
 * Origins the daemon stamps for a session that a MACHINE started for its own
 * bookkeeping, not a person — today just `gate` (POST /sessions/agent's
 * `origin: "gate"`, stamped by the agentik-studio push gate's per-push
 * reviewer spawn). Before the gate started labelling+killing its own
 * sessions, 77 of them piled up live on one operator's daemon, and every
 * consumer of the sessions list rendered them identically to a session the
 * operator actually started.
 *
 * This is the ONE place that string compares against an origin slug to
 * decide "is this machinery" — sessionsTree.ts (group glyph + sort),
 * statusBar.logic.ts (excluded from the needs-you/stalled/working/idle
 * counts), and sessionFilter.logic.ts (the origin filter dimension +
 * agentproto.hideMachineSessions default) all read `isMachineOrigin`
 * instead of re-testing `=== "gate"`. A second machine origin is a one-line
 * addition to this Set, not a grep across three files.
 */
const MACHINE_ORIGINS = new Set<string>(["gate"])

export function isMachineOrigin(origin: string | undefined): boolean {
  return origin !== undefined && MACHINE_ORIGINS.has(origin)
}

/** Stable TreeItem id for an origin group row — distinct namespace from the
 *  workspace groups so the two can never collide on id. */
export function originGroupNodeId(origin: string): string {
  return `origin-group:${origin}`
}

/**
 * One GroupNode per distinct ORIGIN — "Claude Code (desktop)", "VS Code
 * extension", "Cron", … — the client mirror of the daemon's
 * `groupRootsByOrigin` (session-tools.ts). Sessions are bucketed by their ROOT
 * ancestor's origin (walking `parentSessionId` up within the provided set) so
 * a child stays nested under its root's group rather than splitting into its
 * own origin bucket; each bucket's rows reuse `buildSessionRows` unchanged (24h
 * divider + parentSessionId nesting). Buckets sort alphabetically by label,
 * with the `unknown` bucket always last. A root with no origin lands in
 * `unknown` rather than being dropped.
 *
 * Machine-origin buckets (isMachineOrigin — e.g. `gate`) sort AFTER every
 * human-origin bucket regardless of count, and only then alphabetically
 * among themselves — an operator with one live session of their own and a
 * hundred queued gate reviews should never scroll past the gate group to
 * reach their own. `unknown` still sorts last of all: it isn't "known to be
 * automated", it's "we don't know", which is worse than either.
 */
export function buildOriginGroups(
  sessions: readonly SessionDescriptor[],
  now: number,
): GroupNode[] {
  const groups = groupSessionsByRoot(
    sessions,
    now,
    root => root.origin ?? UNKNOWN_ORIGIN_SLUG,
    slug => ({ id: originGroupNodeId(slug), label: originLabelFor(slug) }),
    "origin",
  )
  return groups.sort((a, b) => {
    if (a.slug === UNKNOWN_ORIGIN_SLUG) return b.slug === UNKNOWN_ORIGIN_SLUG ? 0 : 1
    if (b.slug === UNKNOWN_ORIGIN_SLUG) return -1
    const aMachine = isMachineOrigin(a.slug)
    const bMachine = isMachineOrigin(b.slug)
    if (aMachine !== bMachine) return aMachine ? 1 : -1
    return a.label.localeCompare(b.label)
  })
}

/** Stable TreeItem id for a status group row. */
export function statusGroupNodeId(category: StatusCategory): string {
  return `status-group:${category}`
}

/**
 * One GroupNode per coarse status bucket — Awaiting you / Live / Failed /
 * Stopped / Done — keyed off each session's ROOT status (so an orchestrator
 * subtree groups by the root's state, staying intact, uniform with the origin
 * and workspace views). Buckets render in attention-first order
 * (`STATUS_CATEGORY_ORDER`); empty categories are omitted. `now` matters here
 * (unlike origin): a stalled session folds into `live` only relative to the
 * current clock.
 */
export function buildStatusGroups(
  sessions: readonly SessionDescriptor[],
  now: number,
): GroupNode[] {
  const groups = groupSessionsByRoot(
    sessions,
    now,
    root => statusCategoryFor(root, now),
    category => ({
      id: statusGroupNodeId(category as StatusCategory),
      label: statusCategoryLabel(category as StatusCategory),
    }),
    "status",
  )
  const rank = new Map(STATUS_CATEGORY_ORDER.map((c, i) => [c as string, i]))
  return groups.sort(
    (a, b) => (rank.get(a.slug) ?? 99) - (rank.get(b.slug) ?? 99),
  )
}

/**
 * Shared bucketing for the "by source" and "by status" views: assign each
 * session to a bucket keyed off its ROOT ancestor (walking `parentSessionId`
 * within the provided set, cycle-guarded) so children stay nested under their
 * root's group rather than splitting off; each bucket's rows reuse
 * `buildSessionRows` (24h divider + parentSessionId nesting) unchanged. Buckets
 * are returned in first-appearance order — callers sort as they see fit.
 */
function groupSessionsByRoot(
  sessions: readonly SessionDescriptor[],
  now: number,
  keyOfRoot: (root: SessionDescriptor) => string,
  metaOf: (slug: string) => { id: string; label: string },
  variant: NonNullable<GroupNode["variant"]>,
): GroupNode[] {
  const byId = new Map(sessions.map(s => [s.id, s]))
  const rootKeyOf = (start: SessionDescriptor): string => {
    let cur = start
    const seen = new Set<string>([cur.id])
    while (cur.parentSessionId && byId.has(cur.parentSessionId)) {
      const parent = byId.get(cur.parentSessionId)!
      if (seen.has(parent.id)) break // cycle guard
      seen.add(parent.id)
      cur = parent
    }
    return keyOfRoot(cur)
  }

  const order: string[] = []
  const buckets = new Map<string, SessionDescriptor[]>()
  for (const session of sessions) {
    const key = rootKeyOf(session)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(session)
    else {
      buckets.set(key, [session])
      order.push(key)
    }
  }

  return order.map(slug => {
    const bucket = buckets.get(slug)!
    const { id, label } = metaOf(slug)
    return {
      kind: "group",
      id,
      slug,
      label,
      count: bucket.length,
      isOpen: false,
      children: buildSessionRows(bucket, now),
      variant,
    }
  })
}

/** How the sessions panel groups its top level. `"none"` = the flat list;
 *  `"workspace"` = one group per registered workspace (+ CTAs); `"origin"` =
 *  one group per source (Claude Code desktop / VS Code / cron / …);
 *  `"status"` = one group per state (Awaiting / Live / Failed / …). */
export type SessionGrouping = "none" | "workspace" | "origin" | "status"

export interface BuildSessionsRootsOptions {
  grouping: SessionGrouping
  /** Whether the sessions passed in already went through an active filter —
   *  see BuildWorkspaceGroupsOptions.hideEmpty. */
  filterActive: boolean
}

/**
 * The tree's single top-level entry point. `"none"` is byte-identical to
 * today's flat list (`buildSessionRows`, no groups, no CTA); `"workspace"`
 * prepends any "Create workspace here" rows ahead of the workspace groups;
 * `"origin"` buckets by source. Kept here (not in the provider) so the
 * grouping decision is itself a pure, tested function.
 */
export function buildSessionsRoots(
  sessions: readonly SessionDescriptor[],
  config: WorkspacesConfig,
  openFolderPaths: readonly string[],
  now: number,
  opts: BuildSessionsRootsOptions,
): RootNode[] {
  if (opts.grouping === "origin") return buildOriginGroups(sessions, now)
  if (opts.grouping === "status") return buildStatusGroups(sessions, now)
  if (opts.grouping !== "workspace") return buildSessionRows(sessions, now)
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
