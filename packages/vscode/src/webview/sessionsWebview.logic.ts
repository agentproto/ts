/**
 * Pure sessions-WEBVIEW row/group model — NO vscode import, so it's
 * unit-testable under plain vitest (sessionsWebviewPanel.ts wraps this into
 * the webview's HTML/postMessage payload, same split as sessionsTree.ts vs.
 * sessionsTree.logic.ts).
 *
 * Deliberately thin: every grouping, recency-split, subagent-nesting, and
 * filter decision is DELEGATED to the tree's own logic modules
 * (sessionsTree.logic.ts, sessionsGroups.logic.ts, sessionFilter.logic.ts) and
 * the workspace metadata helpers (workspaces.logic.ts) — this module only
 * reshapes their output into the flat two-line-row shape
 * `sessions-webview-demo-models.html` (the locked design mock) expects, now
 * as a single continuous list with per-row workspace tags and lifecycle
 * actions. That reuse is the point: the tree and the webview must never
 * disagree about which sessions exist, how they're grouped, or which are
 * nested under a parent — only how a row is PAINTED.
 *
 * ARCHITECTURE NOTE (progressive loading): the webview consumes
 * {@link SessionSummary} rows from the new `GET /sessions/summaries` endpoint
 * rather than the full `GET /sessions` SessionDescriptor snapshot. A summary
 * carries every field this panel renders (name, status, activity, cost,
 * context, workspace/isolation, parent/child nesting, resume chains) and
 * deliberately excludes large resume/transcript/policy context that the panel
 * never shows. This keeps first paint bounded and daemon serialization work
 * low even when the daemon holds hundreds of sessions. The tree and transcript
 * panels continue to use the full SessionDescriptor via SessionStore unchanged.
 */

import type { SessionSummary, WorkspacesConfig } from "../client/types.js"
import { isLiveSession } from "../commands/sessionActions.logic.js"
import { findWorkspaceByPath } from "../services/workspaces.logic.js"
import { isPendingSession } from "../services/pending.logic.js"
import {
  EMPTY_FILTER,
  filterSessions,
  type SessionFilterState,
} from "../views/sessionFilter.logic.js"
import {
  activityFor,
  activityLineFor,
  buildSessionTree,
  bucketFor,
  collapseResumeChains,
  compareSessions,
  contextPercent,
  isolationLabelFor,
  labelFor,
  relativeTime,
  type SessionActivity,
  type SessionNode,
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

export function webviewRowStatus(session: SessionSummary, now?: number): WebviewRowStatus {
  return ACTIVITY_TO_ROW_STATUS[activityFor(session, now)]
}

/** Per-row lifecycle action exposed by the webview. */
export type RowAction = "stop" | "archive" | "unarchive"

const TERMINAL_STATUSES = new Set<SessionSummary["status"]>(["exited", "killed", "error"])

/**
 * Which lifecycle action a row should offer, if any. Mirrors the existing
 * command/menu gating (`isLiveSession`, terminal status) so the webview never
 * invents its own policy. The summary projection omits `endedReason`, so a
 * killed session is treated as a normal terminal row here; the tree's full
 * descriptor path continues to distinguish resumable-in-place ghosts.
 */
export function rowActionFor(session: SessionSummary): RowAction | undefined {
  if (isPendingSession(session)) return undefined
  if (session.archived) return "unarchive"
  if (isLiveSession(session)) return "stop"
  if (TERMINAL_STATUSES.has(session.status)) return "archive"
  return undefined
}

/** Stable, theme-agnostic accent palette for workspace tags. Mid-luminance so the color reads as an accent in both light and dark themes. */
export const WORKSPACE_PALETTE: readonly string[] = [
  "#c45c26", // orange
  "#2a8f5c", // green
  "#3b82f6", // blue
  "#8b5cf6", // purple
  "#d946ef", // magenta
  "#0ea5e9", // cyan
  "#ca8a04", // gold
  "#ef4444", // red
]

/** Dedicated index for rows with no resolvable workspace — a neutral gray outside the accent palette. */
export const UNASSIGNED_COLOR_INDEX = WORKSPACE_PALETTE.length

/** Relative luminance of an sRGB color (for accessibility sanity checks). */
export function relativeLuminance(hex: string): number {
  const rgb = [1, 3, 5].map(offset => {
    const v = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!
}

/**
 * Deterministic, stable workspace color. Hashing the workspace slug means
 * adding or removing workspaces never shifts another workspace's color.
 */
export function workspaceColorFor(slug: string): { index: number; css: string } {
  if (slug === "__unassigned__") {
    return { index: UNASSIGNED_COLOR_INDEX, css: "#808080" }
  }
  const hash = [...slug].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 0)
  const index = hash % WORKSPACE_PALETTE.length
  return { index, css: WORKSPACE_PALETTE[index]! }
}

/** Workspace identity attached to a row for tag rendering. */
export interface WebviewWorkspace {
  slug: string
  label: string
  colorIndex: number
}

/** One rendered row — a root session or one of its flattened subagent descendants. */
export interface WebviewRow {
  id: string
  session: SessionSummary
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
  /** Lifecycle action for this row, if any. */
  action: RowAction | undefined
  /** Workspace tag metadata. */
  workspace: WebviewWorkspace | undefined
  /** Mirrors `session.archived` so the UI can style archived rows. */
  archived: boolean
}

export interface WebviewSection {
  recent: WebviewRow[]
  older: WebviewRow[]
}

export type SessionsWebviewTab = "all" | "working" | "awaiting" | "idle" | "stalled" | "done" | "archived"

/**
 * Tab → the set of {@link SessionActivity} values it should show. The tree's
 * classifier is the single source of truth; these tabs are just presentation
 * buckets. "Stalled / failed" gathers every incomplete non-live state
 * (stalled, failed, or stopped mid-turn) so nothing terminal leaks into
 * "Working"/"Idle" and nothing incomplete is filed under "Done".
 */
const TAB_TO_ACTIVITIES: Readonly<
  Record<Exclude<SessionsWebviewTab, "all" | "archived">, readonly SessionActivity[]>
> = {
  working: ["working"],
  awaiting: ["needs-you"],
  idle: ["idle"],
  stalled: ["stalled", "failed", "stopped"],
  done: ["done"],
}

function toRow(
  session: SessionSummary,
  isSub: boolean,
  now: number,
  workspaces: WorkspacesConfig,
): WebviewRow {
  const pctStr = contextPercent(session.contextUsed, session.contextSize)
  const ws = workspaceFor(workspaces, session)
  const workspace: WebviewWorkspace | undefined = ws
    ? { slug: ws.slug, label: ws.label, colorIndex: workspaceColorFor(ws.slug).index }
    : undefined
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
    action: rowActionFor(session),
    workspace,
    archived: session.archived === true,
  }
}

/** Depth-first flatten of a session and its (recursively nested) children — every descendant renders `isSub`, regardless of depth, matching the mock's single indentation level. */
function flattenNode(
  node: SessionNode,
  isSub: boolean,
  now: number,
  workspaces: WorkspacesConfig,
  out: WebviewRow[],
): void {
  out.push(toRow(node.session, isSub, now, workspaces))
  for (const child of node.children) flattenNode(child, true, now, workspaces, out)
}

function sectionFor(
  roots: readonly SessionNode[],
  now: number,
  workspaces: WorkspacesConfig,
): WebviewSection {
  const recentRows: WebviewRow[] = []
  const olderRows: WebviewRow[] = []
  for (const root of roots) {
    if (bucketFor(root.session, now) === "recent") {
      flattenNode(root, false, now, workspaces, recentRows)
    } else {
      flattenNode(root, false, now, workspaces, olderRows)
    }
  }
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
  sessions: readonly SessionSummary[],
  activities: readonly SessionActivity[],
  now: number,
): SessionSummary[] {
  const matched = new Set<string>()
  for (const session of sessions) {
    if (activities.includes(activityFor(session, now))) matched.add(session.id)
  }
  if (matched.size === 0) return []

  const childrenByParent = new Map<string, SessionSummary[]>()
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

/** Resolve a session's workspace to a stable slug/label, or undefined when unassigned. */
function workspaceFor(
  config: WorkspacesConfig,
  session: Pick<SessionSummary, "cwd" | "workspaceSlug">,
): { slug: string; label: string } | undefined {
  if (session.cwd) {
    const byPath = findWorkspaceByPath(config, session.cwd)
    if (byPath) return { slug: byPath.slug, label: byPath.label ?? byPath.slug }
  }
  if (session.workspaceSlug && session.workspaceSlug !== "default") {
    const bySlug = config.workspaces.find(w => w.slug === session.workspaceSlug)
    if (bySlug) return { slug: bySlug.slug, label: bySlug.label ?? bySlug.slug }
  }
  return undefined
}

export interface SessionsWebviewModel {
  section: WebviewSection
  /** Rows actually rendered across recent + older (roots + nested children). */
  shownCount: number
  /** Summaries currently loaded into the webview (the available result set). */
  loadedCount: number
  /** Total sessions reported by the daemon for this archived/visible view. */
  serverTotal: number
}

export interface BuildSessionsWebviewModelOptions {
  tab: SessionsWebviewTab
  /** The pinned filter input's live text — matched against name/command/cwd/id via the reused sessionFilter.logic.ts predicate. */
  search: string
  now: number
}

/**
 * The webview's single entry point — now a single continuous list ordered by
 * recency and parent-child nesting. Filtering (search, activity tab, archived)
 * is applied first; the survivors are then collapsed, re-nested, sorted, and
 * split into a global recent/older divider.
 *
 * The input is a {@link SessionSummary} slice from `GET /sessions/summaries`,
 * not the full SessionDescriptor snapshot. Search and status tabs operate
 * honestly over the loaded (available) set; older sessions become available
 * via the panel's load-more affordance.
 */
export function buildSessionsWebviewModel(
  sessions: readonly SessionSummary[],
  workspaces: WorkspacesConfig,
  opts: BuildSessionsWebviewModelOptions,
): SessionsWebviewModel {
  // 1. Search filter (reused predicate with parent retention).
  const baseState: SessionFilterState = { ...EMPTY_FILTER, search: opts.search }
  const searchSurvivors = filterSessions(sessions, baseState, workspaces)

  // 2. Activity / archived tab filter.
  let tabSurvivors: SessionSummary[]
  if (opts.tab === "archived") {
    tabSurvivors = searchSurvivors.filter(s => s.archived === true)
  } else if (opts.tab === "all") {
    tabSurvivors = searchSurvivors
  } else {
    tabSurvivors = retainSessionsByActivity(searchSurvivors, TAB_TO_ACTIVITIES[opts.tab], opts.now)
  }

  // 3. Collapse resume chains, build the nested tree, sort globally.
  const collapsed = collapseResumeChains(tabSurvivors)
  const roots = buildSessionTree(collapsed)
  roots.sort((a, b) => compareSessions(a.session, b.session))

  // 4. Flatten into a single recent/older section.
  const section = sectionFor(roots, opts.now, workspaces)
  const shownCount = section.recent.length + section.older.length

  return { section, shownCount, loadedCount: sessions.length, serverTotal: sessions.length }
}

/** The panel's subtitle line: "50 of 283 loaded" when unfiltered, "3 of 50 shown" when filtered. */
export function summaryTextFor(model: SessionsWebviewModel, filterActive: boolean): string {
  if (filterActive) return `${model.shownCount} of ${model.loadedCount} shown`
  return `${model.loadedCount} of ${model.serverTotal} loaded`
}
