/**
 * Pure sessions-WEBVIEW row/section model — NO vscode import, so it's
 * unit-testable under plain vitest (sessionsWebviewPanel.ts wraps this into
 * the webview's HTML/postMessage payload, same split as sessionsTree.ts vs.
 * sessionsTree.logic.ts).
 *
 * DESIGN B — "Attention-first sections" (validated 2026-08-07). The seven
 * status tabs are gone: status is no longer a control the operator drives, it
 * is the SORT ORDER the list organizes itself into. Every session falls into
 * exactly one of five fixed-priority sections —
 *   Needs you → Running → Attention → Quiet → Earlier
 * — keyed off the tree's canonical `activityFor` classifier, so the webview
 * never disagrees with the tree about what a session IS.
 *
 * Navigation collapses to two axes only, both reusing logic that already
 * exists (NO daemon changes):
 *   - a top PROJECT RAIL (All + one chip per workspace, each with a count and
 *     a tiny ochre dot when that project holds a session awaiting the human),
 *   - an `Agents | Auto` SEGMENTED CONTROL. Agents = human-origin sessions
 *     (the default); Auto = machine-origin sessions, reusing
 *     `isMachineOrigin` (sessionsGroups.logic.ts) plus the cron-origin /
 *     command-kind tells, grouped into Gate reviews / Crons / Commands.
 *
 * Deliberately thin: activity classification, isolation labels, cost/context
 * formatting, workspace resolution, and resume-chain collapsing are all
 * DELEGATED to the tree's own logic modules — this module only reshapes their
 * output into the flat, section-organized row model the webview paints.
 *
 * ARCHITECTURE NOTE (progressive loading): the webview consumes
 * {@link SessionSummary} rows from `GET /sessions/summaries` rather than the
 * full `SessionDescriptor` snapshot. A summary carries every field this panel
 * renders and excludes the large resume/transcript/policy context the panel
 * never shows, keeping first paint bounded even with hundreds of sessions.
 */

import type { SessionSummary, WorkspacesConfig } from "../client/types.js"
import { isLiveSession } from "../commands/sessionActions.logic.js"
import { canArchive, canUnarchive } from "../commands/sessionArchive.logic.js"
import { shortSessionId } from "../client/sessionName.js"
import { isMachineOrigin } from "../views/sessionsGroups.logic.js"
import { findWorkspaceByPath } from "../services/workspaces.logic.js"
import { isPendingSession } from "../services/pending.logic.js"
import {
  EMPTY_FILTER,
  filterSessions,
  type SessionFilterState,
} from "../views/sessionFilter.logic.js"
import {
  ACTIVITY_ROW_MAX,
  activityFor,
  collapseResumeChains,
  compareSessions,
  contextPercent,
  formatDuration,
  isolationLabelFor,
  labelFor,
  relativeTime,
  type SessionActivity,
} from "../views/sessionsTree.logic.js"

/**
 * Harness → glyph, locked by the design mock: "a single monochrome glyph per
 * harness + the model token". Keyed on `adapterSlug` (the same field the
 * tree's harness commands and runtime `SessionDescriptor.adapterSlug` use).
 * Any other/unknown slug falls back to `•`.
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
 * nothing) for a session with no cost yet.
 */
export function formatCost(costUsd: number | undefined): string | undefined {
  if (typeof costUsd !== "number" || !(costUsd > 0)) return undefined
  return `$${costUsd.toFixed(2)}`
}

/**
 * Internal bookkeeping lines the daemon may leave in `activitySummary.text`
 * that must NEVER surface as a row preview — they aren't a real user/agent
 * message. Two shapes are filtered:
 *   - a leading role tag the runtime prefixes onto injected lines, e.g.
 *     "[context] …", "[continuity] …", "[system] …";
 *   - the context-continuity decision line itself even when it arrives
 *     un-tagged, e.g. "context at 69% — waiting for user decision (continue
 *     fresh…)".
 * Kept deliberately narrow so a genuine message that merely mentions "context"
 * is never swallowed.
 */
const SYSTEM_PREVIEW_TAG = /^\s*\[(context|continuity|system|compaction|checkpoint|internal)\]/i
const CONTINUITY_PHRASE =
  /context at \d+%|waiting for user decision|continue fresh|continuing fresh|context (window )?(is )?(full|at capacity|nearly full)/i

/** True when a preview candidate is the daemon's own context/system bookkeeping rather than a genuine user/agent message. */
export function isSystemPreviewLine(text: string): boolean {
  return SYSTEM_PREVIEW_TAG.test(text) || CONTINUITY_PHRASE.test(text)
}

/**
 * Flatten inline Markdown to plain text for a single-line preview — the row's
 * preview is one clamped line, so the raw markers ("**bold**", "`code`",
 * "[label](url)") must not leak through as literal punctuation. Deliberately
 * lossy and dependency-free (the full renderMarkdown is for the transcript
 * book, not a sidebar row): strips emphasis/code/heading/quote/list markers,
 * unwraps links to their label, and collapses all whitespace to single spaces.
 */
export function stripMarkdownToText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → label
    .replace(/`+/g, "") // inline code ticks
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
    .replace(/(\*|_)(.*?)\1/g, "$2") // italic
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // ATX headings
    .replace(/^\s{0,3}>\s?/gm, "") // blockquotes
    .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, "") // list markers
    .replace(/\s+/g, " ") // collapse whitespace → single line
    .trim()
}

/**
 * The row's preview line — the last genuine user/agent message, markdown
 * stripped and clamped to a single truncated line. Sourced from the daemon's
 * `activitySummary.text` (its "what is this doing now" heuristic), but with the
 * runtime's internal context-continuity / system lines filtered out
 * ({@link isSystemPreviewLine}) so a row never shows "[context] context at 69%
 * — waiting for user decision" in place of real work. Returns undefined when
 * there is nothing genuine to show — better a bare row than a misleading one.
 */
export function previewTextFor(session: Pick<SessionSummary, "activitySummary">): string | undefined {
  const raw = session.activitySummary?.text?.trim()
  if (!raw || isSystemPreviewLine(raw)) return undefined
  const plain = stripMarkdownToText(raw)
  if (!plain) return undefined
  return plain.length > ACTIVITY_ROW_MAX ? `${plain.slice(0, ACTIVITY_ROW_MAX - 1)}…` : plain
}

/**
 * The row's status dot — driven directly by the tree's `activityFor`
 * classifier. Each activity gets its own CSS class; only `working` rows pulse
 * (moss), and only `awaiting` rows take the ochre accent — the one signal
 * allowed to catch the eye.
 */
export type WebviewRowStatus =
  | "working"
  | "delegating" // idle itself, but its subtree is mid-turn (#session-visibility)
  | "awaiting"
  | "parked" // idle + a supervisor is waiting on it — will be re-prompted
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
  "parked-bg": "parked",
  failed: "failed",
  stopped: "stopped",
  done: "done",
}

/**
 * Busiest-first rank for the visibility states (#session-visibility), used to
 * roll a collapsed parent up to the busiest state in its subtree and to sort
 * within a section. Precedence: working > delegating > awaiting > stalled >
 * parked > idle > terminal.
 */
export const ROW_STATUS_RANK: Readonly<Record<WebviewRowStatus, number>> = {
  working: 8,
  delegating: 7,
  awaiting: 6,
  stalled: 5,
  parked: 4,
  idle: 3,
  failed: 2,
  stopped: 1,
  done: 0,
}

/** The busier of two row states (ties keep the first) — the subtree-rollup op. */
export function busierRowStatus(a: WebviewRowStatus, b: WebviewRowStatus): WebviewRowStatus {
  return ROW_STATUS_RANK[b] > ROW_STATUS_RANK[a] ? b : a
}

/**
 * The row's presented status. Starts from the shared `activityFor`, then
 * refines a genuinely-idle (alive, quiet, not-awaiting) session into
 * "delegating" (its subtree is mid-turn) or "parked" (a supervisor is waiting
 * on it). These refine ONLY `idle` — never override working/awaiting/terminal —
 * so the precedence busy > delegating > awaiting > parked > quiet holds.
 */
export function webviewRowStatus(session: SessionSummary, now?: number): WebviewRowStatus {
  const base = ACTIVITY_TO_ROW_STATUS[activityFor(session, now)]
  if (base === "idle") {
    if ((session.childrenBusy ?? 0) > 0) return "delegating"
    if ((session.watchers ?? 0) > 0) return "parked"
  }
  return base
}

/** Per-row lifecycle action exposed by the webview. */
export type RowAction = "stop" | "archive" | "unarchive"

export function rowActionFor(session: SessionSummary): RowAction | undefined {
  if (isPendingSession(session)) return undefined
  if (canUnarchive(session)) return "unarchive"
  if (isLiveSession(session)) return "stop"
  if (canArchive(session)) return "archive"
  return undefined
}

/** Stable, theme-agnostic accent palette for the workspace color square. Mid-luminance so the color reads as an accent in both light and dark themes. */
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

/** Human-readable names for {@link WORKSPACE_PALETTE}, same order — accessible labels for the color-picker swatches. */
export const WORKSPACE_PALETTE_NAMES: readonly string[] = [
  "Orange",
  "Green",
  "Blue",
  "Purple",
  "Magenta",
  "Cyan",
  "Gold",
  "Red",
]

/** Dedicated index for rows with no resolvable workspace — a neutral gray outside the accent palette. */
export const UNASSIGNED_COLOR_INDEX = WORKSPACE_PALETTE.length

/** The neutral gray used for {@link UNASSIGNED_COLOR_INDEX} — also selectable as a swatch on any workspace. */
export const UNASSIGNED_COLOR_CSS = "#808080"

/** Sentinel slug for the "no resolvable workspace" bucket in the project rail. */
export const UNASSIGNED_SLUG = "__unassigned__"

/** Per-slug user color override — a palette index (0..{@link UNASSIGNED_COLOR_INDEX}), keyed by workspace slug. */
export type WorkspaceColorOverrides = Readonly<Record<string, number>>

/** Resolve a palette index (including {@link UNASSIGNED_COLOR_INDEX}) to its css color. */
function cssForPaletteIndex(index: number): string {
  return index === UNASSIGNED_COLOR_INDEX ? UNASSIGNED_COLOR_CSS : WORKSPACE_PALETTE[index]!
}

/** Whether a value is a valid palette index an override may carry — an integer in [0, {@link UNASSIGNED_COLOR_INDEX}]. */
export function isValidColorIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= UNASSIGNED_COLOR_INDEX
}

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
 * adding or removing workspaces never shifts another workspace's color —
 * this is the fallback used when `overrides` carries no entry for `slug`.
 * An override (set via the rail chip's swatch popover) always wins.
 */
export function workspaceColorFor(
  slug: string,
  overrides?: WorkspaceColorOverrides,
): { index: number; css: string } {
  const override = overrides?.[slug]
  if (isValidColorIndex(override)) {
    return { index: override, css: cssForPaletteIndex(override) }
  }
  if (slug === UNASSIGNED_SLUG) {
    return { index: UNASSIGNED_COLOR_INDEX, css: UNASSIGNED_COLOR_CSS }
  }
  const hash = [...slug].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 0)
  const index = hash % WORKSPACE_PALETTE.length
  return { index, css: WORKSPACE_PALETTE[index]! }
}

/** Workspace identity attached to a row for the 6px color-square + label. */
export interface WebviewWorkspace {
  slug: string
  label: string
  colorIndex: number
}

/** Which of the two segmented-control lanes a session belongs to. */
export type SessionLane = "agents" | "auto"

/** Auto-lane subgroups, in display order. */
export type AutoGroupKind = "gate" | "cron" | "command"

/**
 * The Auto-lane subgroup a machine-origin session belongs to, or undefined
 * when the session is human-origin (an "Agents"-lane session). Reuses the
 * shared `isMachineOrigin` (today: `gate`) and adds the two other machine
 * tells the webview needs to separate — a cron-fired session (`origin` is
 * `"cron"`, stamped by the cron scheduler) and a raw command execution
 * (`kind === "command"`). No daemon change: these are all existing fields.
 */
export function autoGroupOf(session: Pick<SessionSummary, "origin" | "kind">): AutoGroupKind | undefined {
  if (isMachineOrigin(session.origin)) return "gate"
  if (session.origin === "cron") return "cron"
  if (session.kind === "command") return "command"
  return undefined
}

/** Human-origin ("agents") vs machine-origin ("auto") — the segmented-control axis. */
export function laneOf(session: Pick<SessionSummary, "origin" | "kind">): SessionLane {
  return autoGroupOf(session) === undefined ? "agents" : "auto"
}

const AUTO_GROUP_LABELS: Readonly<Record<AutoGroupKind, string>> = {
  gate: "Gate reviews",
  cron: "Crons",
  command: "Commands",
}

export const AUTO_GROUP_ORDER: readonly AutoGroupKind[] = ["gate", "cron", "command"]

/**
 * The cron job id a cron session runs under, extracted from its
 * `cron:<jobId>` label (stamped by the runtime's cron scheduler). Undefined
 * when the session is not a labelled cron run — the collapsing pass then
 * leaves it as its own row.
 */
export function cronJobIdOf(session: Pick<SessionSummary, "label">): string | undefined {
  const match = /^cron:(.+)$/.exec(session.label ?? "")
  return match ? match[1] : undefined
}

/** Short, human tell for a cron job id — `cron_d8ee2e36-abcd-…` → `d8ee2e36`. */
function shortCronId(jobId: string): string {
  const trimmed = jobId.replace(/^cron_/, "").replace(/-.*$/, "").slice(0, 8)
  return trimmed || jobId
}

/**
 * Machine-session name cleanup. A cron/command/gate session carries an
 * unfriendly raw label (`cron:cron_d8ee2e36-…`) that `sessionDisplayName`
 * would surface verbatim; here it collapses to a clean `<kind> · <short id>`:
 *   - gate    → `gate-review`      (no id — the verdict file is the identity)
 *   - cron    → `cron · d8ee2e36`  (the cron job's short id)
 *   - command → `command · f2e358` (the session's short id)
 * Anything else falls through to the shared `labelFor`.
 */
function nameIdentityFor(session: SessionSummary): { name: string; idMono: string | undefined } {
  switch (autoGroupOf(session)) {
    case "gate":
      return { name: "gate-review", idMono: undefined }
    case "cron": {
      const jobId = cronJobIdOf(session)
      return { name: "cron", idMono: jobId ? shortCronId(jobId) : shortSessionId(session.id) }
    }
    case "command":
      return { name: "command", idMono: shortSessionId(session.id) }
    default:
      return { name: labelFor(session), idMono: undefined }
  }
}

/**
 * Whether a gate-review session records an approval — surfaced as the row's
 * optional `✓ approved` badge. Heuristic (no structured verdict field on the
 * summary, and no daemon change to add one): the persisted activity line of an
 * approving gate mentions its verdict. Conservative: only gate-lane sessions
 * are ever considered.
 */
export function gateApproved(session: SessionSummary): boolean {
  if (autoGroupOf(session) !== "gate") return false
  return /approv/i.test(session.activitySummary?.text ?? "")
}

/**
 * Tooltip text for the ⚠ stalled badge, or undefined when the daemon's
 * turn-liveness watchdog hasn't flagged this session. `session.stalledSinceMs`
 * is the epoch ms of the last real adapter activity observed before the
 * watchdog tripped — "silent for" is `now - stalledSinceMs`, exactly like
 * the tree's own `silentForMs`, just server-confirmed rather than a live
 * client-side clock comparison.
 */
export function stallTooltipFor(session: SessionSummary, now: number): string | undefined {
  if (typeof session.stalledSinceMs !== "number") return undefined
  const silentFor = formatDuration(Math.max(0, now - session.stalledSinceMs))
  return `no adapter activity for ${silentFor} mid-turn — stream may be dead`
}

/** One rendered row. Flat — Design B organizes by attention section, not by parent/child nesting. */
export interface WebviewRow {
  id: string
  session: SessionSummary
  status: WebviewRowStatus
  lane: SessionLane
  name: string
  /** The `· <id>` mono segment, for machine rows that split name from id. */
  idMono: string | undefined
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
  /** Number of collapsed consecutive cron runs (≥2), else undefined. */
  runs: number | undefined
  /** True when this gate-review row records an approval. */
  approved: boolean
  /** True when the session is kept alive (idle-reaper exempt) — the daemon's
   *  own keepAlive flag. Distinct from BOTH watch signals: not the local eye. */
  watched: boolean
  /** True when the operator pinned the LOCAL watch eye on this session
   *  (WatchedSessions service) — renders the plain 👁 (no count), with the
   *  "you get a notification" tooltip. Same glyph as the tree's watched prefix. */
  locallyWatched: boolean
  /** Count of live supervisors blocked waiting on this session right now
   *  (#session-visibility) — distinct from `watched` (keepAlive): this is the
   *  real "is anything watching it" signal (wait long-polls / session_monitor).
   *  Drives the eye badge when > 0. */
  watcherCount: number
  /** Background tool starts from the last turn still pending — the session
   *  parked itself with work outstanding. Drives the `⏳ N bg` chip when > 0. */
  pendingBgTasks: number
  /** Descendant sessions currently mid-turn (#session-visibility) — drives the
   *  "⟳ N children" delegating badge. */
  childrenBusy: number
  /** Source channel that spawned this session (cowork / vscode / cron / codex),
   *  for the origin chip. Undefined ⇒ unknown/unstamped root. */
  originLabel: string | undefined
  /** Tooltip text for the ⚠ stalled badge — set iff the daemon's
   *  turn-liveness watchdog flagged this session (`session.stalledSinceMs`
   *  present). Distinct from the client-side `status === "stalled"`
   *  heuristic (silence + busy, no `blockedOn` exemption): this is a
   *  server-confirmed signal, so it gets its own badge rather than
   *  reusing the dot color. Undefined ⇒ not currently flagged, no badge. */
  stallTooltip: string | undefined
  /** Nesting depth in the parentSessionId lineage — 0 for a root, +1 per
   *  ancestor present in the same section. Drives the row's indent. */
  depth: number
  /** Lifecycle action for this row, if any. */
  action: RowAction | undefined
  /** Workspace color-square metadata. */
  workspace: WebviewWorkspace | undefined
  /** Mirrors `session.archived` so the UI can style archived rows. */
  archived: boolean
}

/** The five attention sections, in fixed priority order. */
export type SectionKey = "needs-you" | "running" | "attention" | "quiet" | "earlier"

export const SECTION_ORDER: readonly SectionKey[] = [
  "needs-you",
  "running",
  "attention",
  "quiet",
  "earlier",
]

const SECTION_LABELS: Readonly<Record<SectionKey, string>> = {
  "needs-you": "Needs you",
  running: "Running",
  attention: "Attention",
  quiet: "Quiet",
  earlier: "Earlier",
}

/** A section's optional right-aligned hint (only "Earlier" carries one). */
const SECTION_HINTS: Readonly<Partial<Record<SectionKey, string>>> = {
  earlier: "last 24 h",
}

/** Fold a row's status into its attention section — the dot and the section
 *  it lands in are then guaranteed to agree (both derive from the same
 *  `now`-aware `activityFor`). */
const SECTION_BY_STATUS: Readonly<Record<WebviewRowStatus, SectionKey>> = {
  awaiting: "needs-you",
  working: "running",
  // A delegating parent is actively working (through its subtree), so it sorts
  // with the live sessions rather than sinking into Quiet.
  delegating: "running",
  stalled: "attention",
  failed: "attention",
  // Parked = quiet but supervised; stays in Quiet, distinguished by its tell.
  parked: "quiet",
  idle: "quiet",
  stopped: "earlier",
  done: "earlier",
}

/** Fold a session's fine-grained activity into its attention section. */
export function sectionFor(session: SessionSummary, now?: number): SectionKey {
  return SECTION_BY_STATUS[webviewRowStatus(session, now)]
}

/** One rendered, collapsible group — an attention section (Agents lane) or an Auto subgroup. */
export interface WebviewGroup {
  key: SectionKey | AutoGroupKind
  label: string
  hint: string | undefined
  rows: WebviewRow[]
}

/** One project-rail chip. `slug === null` is the "All" chip. */
export interface RailEntry {
  slug: string | null
  label: string
  /** Color-square css for a workspace chip; undefined for "All". */
  css: string | undefined
  /** Palette index backing `css` (override or hash default); undefined for "All" — the color-picker's active swatch. */
  colorIndex: number | undefined
  count: number
  /** True when this project holds at least one session awaiting the human. */
  awaiting: boolean
}

export interface SessionsWebviewModel {
  lane: SessionLane
  rail: RailEntry[]
  /** Segmented-control counts for the current project scope. */
  laneCounts: Record<SessionLane, number>
  /** Non-empty sections (Agents lane) or Auto subgroups, in fixed order. */
  groups: WebviewGroup[]
  /** Rows actually rendered across all groups (after cron collapsing). */
  shownCount: number
  /** Summaries currently loaded into the webview (the available result set). */
  loadedCount: number
  /** Total sessions the daemon reports for this view. */
  serverTotal: number
}

export interface BuildSessionsWebviewModelOptions {
  lane: SessionLane
  /** Selected project rail chip — a workspace slug, {@link UNASSIGNED_SLUG}, or null for "All". */
  project: string | null
  /** The filter input's live text — whitespace-tokenized, each token matched (AND, case-insensitive)
   *  against name/command/cwd/id via the reused sessionFilter predicate. */
  search: string
  now: number
  /** Daemon's total session count for this view; defaults to the loaded count. */
  serverTotal?: number
  /** Switch to the archived-only view (the "show archived" toggle). Default
   *  false — the active-only view, exactly as before. When true the pool is
   *  ONLY archived rows; active sessions are excluded, not merged in — the
   *  two states are mutually exclusive views, not additive. */
  includeArchived?: boolean
  /** How many rows the panel has actually paged in from the server, for the
   *  "N of M loaded" footer. Defaults to the input length; pass it explicitly
   *  when the input is padded with live/pinned rows that aren't paged results. */
  loadedCount?: number
  /** Per-slug workspace color overrides (host-persisted via globalState) — see {@link workspaceColorFor}. */
  colorOverrides?: WorkspaceColorOverrides
  /** Locally-watched session ids (WatchedSessions service) — drives the plain
   *  👁 (no count) chip, the same watch glyph the tree renders. */
  watchedIds?: ReadonlySet<string>
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

/** The rail slug a session belongs to — its workspace slug, or the unassigned sentinel. */
function projectSlugOf(config: WorkspacesConfig, session: SessionSummary): string {
  return workspaceFor(config, session)?.slug ?? UNASSIGNED_SLUG
}

function toRow(
  session: SessionSummary,
  now: number,
  config: WorkspacesConfig,
  colorOverrides: WorkspaceColorOverrides | undefined,
  watchedIds: ReadonlySet<string> | undefined,
): WebviewRow {
  const pctStr = contextPercent(session.contextUsed, session.contextSize)
  const ws = workspaceFor(config, session)
  const identity = nameIdentityFor(session)
  return {
    id: session.id,
    session,
    status: webviewRowStatus(session, now),
    lane: laneOf(session),
    name: identity.name,
    idMono: identity.idMono,
    message: previewTextFor(session),
    tag: isolationLabelFor(session),
    harnessGlyph: harnessGlyphFor(session.adapterSlug ?? session.kind),
    model: session.model,
    ctxPercent: pctStr ? Number(pctStr.slice(0, -1)) : undefined,
    cost: formatCost(session.costUsd),
    time: relativeTime(session.lastActivityAt ?? session.lastOutputAt ?? session.startedAt, now),
    runs: undefined,
    approved: gateApproved(session),
    watched: session.keepAlive === true,
    locallyWatched: watchedIds?.has(session.id) === true,
    watcherCount: session.watchers ?? 0,
    pendingBgTasks: session.pendingBgTasks ?? 0,
    childrenBusy: session.childrenBusy ?? 0,
    originLabel: session.origin,
    stallTooltip: stallTooltipFor(session, now),
    depth: 0,
    action: rowActionFor(session),
    workspace: ws
      ? { slug: ws.slug, label: ws.label, colorIndex: workspaceColorFor(ws.slug, colorOverrides).index }
      : undefined,
    archived: session.archived === true,
  }
}

/**
 * Collapse consecutive runs of the SAME cron job into one row carrying an
 * `×N runs` count and the latest run's outcome. Input must be sorted
 * recency-first (as the caller does): the first row of each consecutive
 * same-job streak is the most recent, so it becomes the surviving row and the
 * streak length rides along as `runs`. A row that is not a labelled cron run,
 * or that breaks the streak, stands on its own.
 */
export function collapseCronRuns(rows: readonly WebviewRow[]): WebviewRow[] {
  const out: WebviewRow[] = []
  let i = 0
  while (i < rows.length) {
    const head = rows[i]!
    const jobId = cronJobIdOf(head.session)
    if (!jobId) {
      out.push(head)
      i += 1
      continue
    }
    let count = 1
    while (i + count < rows.length && cronJobIdOf(rows[i + count]!.session) === jobId) {
      count += 1
    }
    out.push(count > 1 ? { ...head, runs: count } : head)
    i += count
  }
  return out
}

/**
 * The webview's single entry point. Filtering (archived-hidden, resume-chain
 * collapse, search, project) is applied first; the survivors are split into
 * the two lanes for the segmented-control counts and the project rail, then
 * the selected lane's scope is sorted and organized — into the five attention
 * sections (Agents) or the three Auto subgroups (Auto), the latter with
 * consecutive cron runs collapsed.
 */
export function buildSessionsWebviewModel(
  sessions: readonly SessionSummary[],
  workspaces: WorkspacesConfig,
  opts: BuildSessionsWebviewModelOptions,
): SessionsWebviewModel {
  // The "show archived" toggle switches between two disjoint views, not an
  // additive merge: OFF shows ONLY active rows, ON shows ONLY archived rows
  // (an archive action slides a row from the active view into the archived
  // one, never both). Resume-chain predecessors collapse to their live tail,
  // same as the tree.
  const pool = opts.includeArchived
    ? sessions.filter(s => s.archived === true)
    : sessions.filter(s => s.archived !== true)
  const visible = collapseResumeChains(pool)

  // 1. Search filter (reused predicate).
  const baseState: SessionFilterState = { ...EMPTY_FILTER, search: opts.search }
  const searchSurvivors = filterSessions(visible, baseState, workspaces)

  // 2. Project rail — counts per project within the CURRENT lane, independent
  //    of the current project selection (the rail IS the selector). A chip
  //    lights its ochre dot when it holds a session awaiting the human.
  const railScope = searchSurvivors.filter(s => laneOf(s) === opts.lane)
  const rail = buildRail(railScope, workspaces, opts.now, opts.colorOverrides)

  // 3. Segmented-control counts — within the selected project.
  const projectSurvivors =
    opts.project === null
      ? searchSurvivors
      : searchSurvivors.filter(s => projectSlugOf(workspaces, s) === opts.project)
  const laneCounts: Record<SessionLane, number> = { agents: 0, auto: 0 }
  for (const s of projectSurvivors) laneCounts[laneOf(s)] += 1

  // 4. The list itself — selected lane, sorted recency-first.
  const scope = projectSurvivors
    .filter(s => laneOf(s) === opts.lane)
    .slice()
    .sort((a, b) => compareSessions(a, b))
  const rows = scope.map(s => toRow(s, opts.now, workspaces, opts.colorOverrides, opts.watchedIds))

  const groups = opts.lane === "agents" ? buildSections(rows) : buildAutoGroups(rows)
  const shownCount = groups.reduce((n, g) => n + g.rows.length, 0)

  return {
    lane: opts.lane,
    rail,
    laneCounts,
    groups,
    shownCount,
    loadedCount: opts.loadedCount ?? sessions.length,
    serverTotal: opts.serverTotal ?? sessions.length,
  }
}

function buildRail(
  scope: readonly SessionSummary[],
  workspaces: WorkspacesConfig,
  now: number,
  colorOverrides: WorkspaceColorOverrides | undefined,
): RailEntry[] {
  const counts = new Map<string, { count: number; awaiting: boolean; label: string }>()
  let allAwaiting = false
  for (const session of scope) {
    const slug = projectSlugOf(workspaces, session)
    const label =
      slug === UNASSIGNED_SLUG ? "Unassigned" : (workspaceFor(workspaces, session)?.label ?? slug)
    const awaiting = activityFor(session, now) === "needs-you"
    allAwaiting = allAwaiting || awaiting
    const entry = counts.get(slug)
    if (entry) {
      entry.count += 1
      entry.awaiting = entry.awaiting || awaiting
    } else {
      counts.set(slug, { count: 1, awaiting, label })
    }
  }

  const projectChips: RailEntry[] = [...counts.entries()]
    .map(([slug, { count, awaiting, label }]) => {
      const color = workspaceColorFor(slug, colorOverrides)
      return {
        slug,
        label,
        css: color.css,
        colorIndex: color.index,
        count,
        awaiting,
      }
    })
    // Unassigned last; otherwise alphabetical by label for a stable order.
    .sort((a, b) => {
      if (a.slug === UNASSIGNED_SLUG) return 1
      if (b.slug === UNASSIGNED_SLUG) return -1
      return a.label.localeCompare(b.label)
    })

  const all: RailEntry = {
    slug: null,
    label: "All",
    css: undefined,
    colorIndex: undefined,
    count: scope.length,
    awaiting: allAwaiting,
  }
  return [all, ...projectChips]
}

/**
 * Re-order a section's rows so each child session sits directly under its
 * parent (parentSessionId lineage), depth-first, with `depth` set for the
 * indent. A row whose parent is absent from THIS bucket is a root at depth 0 —
 * no session is dropped and no cross-section parent is invented (a parent and
 * child can legitimately fall in different attention sections). Sibling and
 * root order is the incoming (already recency-sorted) order. Mirrors the
 * tree's `buildSessionTree` parent/child nesting, flattened for the flat
 * section list. A parentSessionId cycle can't loop: a node is only ever
 * reached once because it's either a root or exactly one parent's child.
 */
export function nestByLineage(rows: readonly WebviewRow[]): WebviewRow[] {
  const byId = new Map(rows.map(r => [r.id, r]))
  const childrenOf = new Map<string, WebviewRow[]>()
  const roots: WebviewRow[] = []
  for (const row of rows) {
    const parentId = row.session.parentSessionId
    if (parentId && parentId !== row.id && byId.has(parentId)) {
      const bucket = childrenOf.get(parentId)
      if (bucket) bucket.push(row)
      else childrenOf.set(parentId, [row])
    } else {
      roots.push(row)
    }
  }
  const out: WebviewRow[] = []
  const walk = (row: WebviewRow, depth: number): void => {
    out.push(row.depth === depth ? row : { ...row, depth })
    for (const child of childrenOf.get(row.id) ?? []) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  return out
}

function buildSections(rows: readonly WebviewRow[]): WebviewGroup[] {
  const byKey = new Map<SectionKey, WebviewRow[]>()
  for (const row of rows) {
    const key = SECTION_BY_STATUS[row.status]
    const bucket = byKey.get(key)
    if (bucket) bucket.push(row)
    else byKey.set(key, [row])
  }
  const groups: WebviewGroup[] = []
  for (const key of SECTION_ORDER) {
    const bucket = byKey.get(key)
    if (bucket && bucket.length > 0) {
      // Stack subagents under their spawner within the section.
      groups.push({ key, label: SECTION_LABELS[key], hint: SECTION_HINTS[key], rows: nestByLineage(bucket) })
    }
  }
  return groups
}

function buildAutoGroups(rows: readonly WebviewRow[]): WebviewGroup[] {
  const byKind = new Map<AutoGroupKind, WebviewRow[]>()
  for (const row of rows) {
    const kind = autoGroupOf(row.session)
    if (!kind) continue
    const bucket = byKind.get(kind)
    if (bucket) bucket.push(row)
    else byKind.set(kind, [row])
  }
  const groups: WebviewGroup[] = []
  for (const kind of AUTO_GROUP_ORDER) {
    const bucket = byKind.get(kind)
    if (!bucket || bucket.length === 0) continue
    const rendered = kind === "cron" ? collapseCronRuns(bucket) : bucket
    groups.push({ key: kind, label: AUTO_GROUP_LABELS[kind], hint: undefined, rows: rendered })
  }
  return groups
}

/** The footer's count line: "50 of 283 loaded" when unfiltered, "3 of 50 shown" when a filter narrows the set. */
export function summaryTextFor(model: SessionsWebviewModel, filterActive: boolean): string {
  if (filterActive) return `${model.shownCount} of ${model.loadedCount} shown`
  return `${model.loadedCount} of ${model.serverTotal} loaded`
}
