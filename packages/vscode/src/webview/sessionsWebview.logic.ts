/**
 * Pure sessions-WEBVIEW row/group model — NO vscode import, so it's
 * unit-testable under plain vitest (sessionsWebviewPanel.ts wraps this into
 * the webview's HTML/postMessage payload, same split as sessionsTree.ts vs.
 * sessionsTree.logic.ts).
 *
 * Deliberately thin: every grouping, recency-split, subagent-nesting, and
 * filter decision is DELEGATED to the tree's own logic modules
 * (sessionsTree.logic.ts, sessionsGroups.logic.ts, sessionFilter.logic.ts) —
 * this module only reshapes their output into the flat two-line-row shape
 * `sessions-webview-demo-models.html` (the locked design mock) expects. That
 * reuse is the point: the tree and the webview must never disagree about
 * which sessions exist, how they're grouped, or which are nested under a
 * parent — only how a row is PAINTED.
 */

import type { SessionDescriptor, WorkspacesConfig } from "../client/types.js"
import {
  EMPTY_FILTER,
  filterSessions,
  type SessionFilterState,
} from "../views/sessionFilter.logic.js"
import { buildSessionsRoots, isCtaNode, isGroupNode } from "../views/sessionsGroups.logic.js"
import {
  activityFor,
  activityLineFor,
  collapseResumeChains,
  contextPercent,
  isolationLabelFor,
  isSeparatorNode,
  labelFor,
  relativeTime,
  type SessionActivity,
  type SessionNode,
  type TreeNode,
} from "../views/sessionsTree.logic.js"

/**
 * Harness → glyph, locked by the design mock (SESSIONS-WEBVIEW-BRIEF.md):
 * "a single monochrome glyph per harness + the model token". Keyed on
 * `adapterSlug` (the same field the tree's harness commands and
 * runtime SessionDescriptor.adapterSlug use — "claude-code" / "hermes" /
 * "codex" / "gemini-cli"). Any other/unknown slug falls back to `•` — a
 * *logo* treatment (SVG marks) can be added later behind `harnessGlyphFor`
 * without touching a call site, but only glyph ships now.
 */
export const HARNESS_GLYPHS: Readonly<Record<string, string>> = {
  "claude-code": "✳",
  hermes: "☿",
  codex: "◈",
  "gemini-cli": "✦",
}

export const HARNESS_GLYPH_FALLBACK = "•"

/** The glyph for a session's harness — `HARNESS_GLYPHS[adapterSlug]`, or the fallback for anything unrecognized/absent. */
export function harnessGlyphFor(adapterSlug: string | undefined): string {
  if (!adapterSlug) return HARNESS_GLYPH_FALLBACK
  return HARNESS_GLYPHS[adapterSlug] ?? HARNESS_GLYPH_FALLBACK
}

/**
 * Cost as the row's trailing money tag, e.g. "$1.24" — undefined (renders
 * nothing) for a session with no cost yet, matching the mock's `s.cost`
 * being absent on a `done` row with $0 spend.
 */
export function formatCost(costUsd: number | undefined): string | undefined {
  if (typeof costUsd !== "number" || !(costUsd > 0)) return undefined
  return `$${costUsd.toFixed(2)}`
}

/**
 * The row's status dot — driven directly by the tree's canonical
 * `activityFor` classifier so the webview never disagrees with the tree
 * about what a session IS. Each activity gets its own CSS class; only
 * `working` rows pulse green, so an idle session never looks active.
 */
export type WebviewRowStatus =
  | "working"
  | "awaiting"
  | "idle"
  | "stalled"
  | "failed"
  | "stopped"
  | "done"

const ACTIVITY_TO_ROW_STATUS: Readonly<Record<SessionActivity, WebviewRowStatus>> = {
  "needs-you": "awaiting",
  working: "working",
  idle: "idle",
  stalled: "stalled",
  failed: "failed",
  stopped: "stopped",
  done: "done",
}

export function webviewRowStatus(session: SessionDescriptor, now?: number): WebviewRowStatus {
  return ACTIVITY_TO_ROW_STATUS[activityFor(session, now)]
}

/** One rendered row — a root session or one of its flattened subagent descendants. */
export interface WebviewRow {
  id: string
  session: SessionDescriptor
  /** True for a subagent nested under a root — indentation + dimming only (no connector line, no box), per the locked mock. */
  isSub: boolean
  status: WebviewRowStatus
  name: string
  /** Line 2 — the session's live activity summary, clamped; absent when there is none yet. */
  message: string | undefined
  /** Line 3 lead segment — isolation posture ("⑂ <worktree>" or "in-place"). */
  tag: string
  harnessGlyph: string
  model: string | undefined
  /** 0–100, or undefined when the daemon hasn't reported a context window yet. */
  ctxPercent: number | undefined
  cost: string | undefined
  time: string
}

export interface WebviewSection {
  recent: WebviewRow[]
  older: WebviewRow[]
}

export interface WebviewGroup {
  id: string
  name: string
  /** Total sessions (roots + nested children) landed in this group — the header's count badge. */
  count: number
  section: WebviewSection
}

export type SessionsWebviewTab = "all" | "working" | "awaiting" | "idle" | "stalled" | "done"

/**
 * Tab → the set of {@link SessionActivity} values it should show. The tree's
 * classifier is the single source of truth; these tabs are just presentation
 * buckets. "Stalled / failed" gathers every incomplete non-live state
 * (stalled, failed, or stopped mid-turn) so nothing terminal leaks into
 * "Working"/"Idle" and nothing incomplete is filed under "Done".
 */
const TAB_TO_ACTIVITIES: Readonly<
  Record<Exclude<SessionsWebviewTab, "all">, readonly SessionActivity[]>
> = {
  working: ["working"],
  awaiting: ["needs-you"],
  idle: ["idle"],
  stalled: ["stalled", "failed", "stopped"],
  done: ["done"],
}

function toRow(session: SessionDescriptor, isSub: boolean, now: number): WebviewRow {
  const pctStr = contextPercent(session.contextUsed, session.contextSize)
  return {
    id: session.id,
    session,
    isSub,
    status: webviewRowStatus(session, now),
    name: labelFor(session),
    message: activityLineFor(session),
    tag: isolationLabelFor(session),
    harnessGlyph: harnessGlyphFor(session.adapterSlug ?? session.kind),
    model: session.model,
    ctxPercent: pctStr ? Number(pctStr.slice(0, -1)) : undefined,
    cost: formatCost(session.costUsd),
    time: relativeTime(session.lastActivityAt ?? session.lastOutputAt ?? session.startedAt, now),
  }
}

/** Depth-first flatten of a session and its (recursively nested) children — every descendant renders `isSub`, regardless of depth, matching the mock's single indentation level. */
function flattenNode(node: SessionNode, isSub: boolean, now: number, out: WebviewRow[]): void {
  out.push(toRow(node.session, isSub, now))
  for (const child of node.children) flattenNode(child, true, now, out)
}

/** Split a GroupNode's TreeNode children (buildSessionRows' own recent/[separator]/older shape) into two SessionNode arrays. */
function splitByRecency(nodes: readonly TreeNode[]): {
  recent: readonly SessionNode[]
  older: readonly SessionNode[]
} {
  const idx = nodes.findIndex(isSeparatorNode)
  if (idx === -1) return { recent: nodes as readonly SessionNode[], older: [] }
  return {
    recent: nodes.slice(0, idx) as readonly SessionNode[],
    older: nodes.slice(idx + 1) as readonly SessionNode[],
  }
}

function sectionFor(nodes: readonly TreeNode[], now: number): WebviewSection {
  const { recent, older } = splitByRecency(nodes)
  const recentRows: WebviewRow[] = []
  for (const root of recent) flattenNode(root, false, now, recentRows)
  const olderRows: WebviewRow[] = []
  for (const root of older) flattenNode(root, false, now, olderRows)
  return { recent: recentRows, older: olderRows }
}

/**
 * Keep sessions whose activity is in `activities`, plus any ancestors needed
 * to preserve the parentSessionId nesting rendered by `buildSessionTree`. This
 * mirrors `filterSessions`'s parent-retention rule, but uses the fine-grained
 * `activityFor` classifier instead of the coarser `SessionFilterState.status`
 * tokens.
 */
function retainSessionsByActivity(
  sessions: readonly SessionDescriptor[],
  activities: readonly SessionActivity[],
  now: number,
): SessionDescriptor[] {
  const matched = new Set<string>()
  for (const session of sessions) {
    if (activities.includes(activityFor(session, now))) matched.add(session.id)
  }
  if (matched.size === 0) return []

  const childrenByParent = new Map<string, SessionDescriptor[]>()
  for (const session of sessions) {
    const parentId = session.parentSessionId
    if (!parentId) continue
    const list = childrenByParent.get(parentId)
    if (list) list.push(session)
    else childrenByParent.set(parentId, [session])
  }

  const descendantMatch = new Map<string, boolean>()
  const hasMatchingDescendant = (id: string): boolean => {
    const cached = descendantMatch.get(id)
    if (cached !== undefined) return cached
    descendantMatch.set(id, false)
    const result = (childrenByParent.get(id) ?? []).some(
      child => matched.has(child.id) || hasMatchingDescendant(child.id),
    )
    descendantMatch.set(id, result)
    return result
  }

  return sessions.filter(session => matched.has(session.id) || hasMatchingDescendant(session.id))
}

export interface SessionsWebviewModel {
  groups: WebviewGroup[]
  /** Rows actually rendered across every group (roots + nested children). */
  shownCount: number
  /** All sessions the store currently holds, before filtering. */
  totalCount: number
}

export interface BuildSessionsWebviewModelOptions {
  tab: SessionsWebviewTab
  /** The pinned filter input's live text — matched against name/command/cwd/id via the reused sessionFilter.logic.ts predicate. */
  search: string
  now: number
}

/**
 * The webview's single entry point — mirrors SessionsTreeProvider.rebuild's
 * own pipeline (filter → collapse resume chains → group), forced to
 * `grouping: "workspace"` (the mock groups "by workspace/repo with a count
 * badge" unconditionally; the tree's other groupings — origin/status/none —
 * aren't offered here). A "Create workspace here" CTA row (buildSessionsRoots'
 * `CtaNode`) has no equivalent in the webview's row shape, so it's dropped.
 */
export function buildSessionsWebviewModel(
  sessions: readonly SessionDescriptor[],
  workspaces: WorkspacesConfig,
  openFolderPaths: readonly string[],
  opts: BuildSessionsWebviewModelOptions,
): SessionsWebviewModel {
  // Run search/workspace/adapter filtering first (with its own parent
  // retention), then apply the tab's activity-based status filter. Keeping the
  // two passes separate lets the webview use the tree's fine-grained
  // `activityFor` classifier without widening the persisted `SessionFilterState`
  // shape that other views/commands rely on.
  const baseState: SessionFilterState = { ...EMPTY_FILTER, search: opts.search }
  const baseSurvivors = filterSessions(sessions, baseState, workspaces)
  const activities = opts.tab === "all" ? undefined : TAB_TO_ACTIVITIES[opts.tab]
  const survivors = activities ? retainSessionsByActivity(baseSurvivors, activities, opts.now) : baseSurvivors
  const collapsed = collapseResumeChains(survivors)
  const roots = buildSessionsRoots(collapsed, workspaces, openFolderPaths, opts.now, {
    grouping: "workspace",
    filterActive: opts.tab !== "all" || opts.search.trim().length > 0,
  })

  const groups: WebviewGroup[] = []
  let shownCount = 0
  for (const root of roots) {
    if (isCtaNode(root) || !isGroupNode(root)) continue
    const section = sectionFor(root.children, opts.now)
    shownCount += section.recent.length + section.older.length
    groups.push({ id: root.id, name: root.label, count: root.count, section })
  }

  return { groups, shownCount, totalCount: sessions.length }
}

/** The panel's "N of M shown" / "M loaded" subtitle line. */
export function summaryTextFor(model: SessionsWebviewModel, filterActive: boolean): string {
  if (filterActive) return `${model.shownCount} of ${model.totalCount} shown`
  return `${model.totalCount} loaded`
}
