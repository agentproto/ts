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
  isFilterActive,
  type SessionFilterState,
} from "../views/sessionFilter.logic.js"
import { buildSessionsRoots, isCtaNode, isGroupNode } from "../views/sessionsGroups.logic.js"
import {
  activityLineFor,
  collapseResumeChains,
  contextPercent,
  isolationLabelFor,
  isSeparatorNode,
  labelFor,
  relativeTime,
  statusCategoryFor,
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
 * The row's status dot — one of the three the mock actually paints (live
 * green dot / awaiting hollow amber ring / done grey), folded from the
 * tree's five-bucket `statusCategoryFor` (awaiting/live/failed/stopped/done).
 * `failed` and `stopped` both read as "done" here: the dot is a coarse
 * at-a-glance signal, and the row's tooltip/transcript still carries the
 * finer distinction on open.
 */
export type WebviewRowStatus = "live" | "awaiting" | "done"

export function webviewRowStatus(session: SessionDescriptor, now?: number): WebviewRowStatus {
  const category = statusCategoryFor(session, now)
  if (category === "awaiting") return "awaiting"
  if (category === "live") return "live"
  return "done"
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

export type SessionsWebviewTab = "all" | "live" | "awaiting" | "done"

/**
 * Tab → SessionFilterState.status. The mock's three non-"all" tabs are
 * coarser than the filter's five categories (mirroring WebviewRowStatus's own
 * fold) — "Done" pulls in `stopped`/`failed` too, so a failed or
 * user-stopped session doesn't just vanish from every tab but "All".
 */
const TAB_TO_STATUS: Readonly<Record<Exclude<SessionsWebviewTab, "all">, SessionFilterState["status"]>> = {
  live: ["live"],
  awaiting: ["awaiting"],
  done: ["done", "stopped", "failed"],
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
  const state: SessionFilterState = {
    ...EMPTY_FILTER,
    status: opts.tab === "all" ? [] : TAB_TO_STATUS[opts.tab],
    search: opts.search,
  }
  const survivors = filterSessions(sessions, state, workspaces)
  const collapsed = collapseResumeChains(survivors)
  const roots = buildSessionsRoots(collapsed, workspaces, openFolderPaths, opts.now, {
    grouping: "workspace",
    filterActive: isFilterActive(state),
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
