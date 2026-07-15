/**
 * Pure sessions-tree mapping/grouping/sorting logic — NO vscode import.
 * sessionsTree.ts wraps these into vscode.TreeItem/ThemeIcon/MarkdownString
 * so the mapping rules stay unit-testable under plain vitest.
 */

import type { SessionDescriptor } from "../client/types.js"

export type SessionContextValue = "session-live" | "session-awaiting" | "session-done"

export interface SessionIcon {
  /** Codicon id (e.g. "play", "sync~spin") — no leading "$()". */
  id: string
  /** Semantic color hint for the icon, if any. */
  color?: "warning" | "error"
}

export interface TooltipField {
  label: string
  value: string
}

export interface SessionNode {
  session: SessionDescriptor
  children: SessionNode[]
}

export type TimeBucket = "recent" | "older"

/**
 * The rule drawn between the recent and the older session rows. Deliberately
 * NOT a group node: sessions stay at the top level, so there is nothing to
 * expand or collapse — this is one inert row that reads as a divider.
 */
export interface SeparatorNode {
  kind: "separator"
  /** Stable TreeItem id; the tree only ever holds one separator. */
  id: string
  /** Divider text, rendered dim — e.g. "──── older than 24h ────". */
  label: string
}

export type TreeNode = SeparatorNode | SessionNode

/** Description-string extras for the richer (post-filter) row rendering — see descriptionFor. */
export interface DescriptionContext {
  workspaceLabel?: string
  now?: number
}

const TERMINAL_STATUSES = new Set<SessionDescriptor["status"]>(["exited", "killed", "error"])

export function isRunning(session: SessionDescriptor): boolean {
  return session.status === "running" || session.status === "starting"
}

export function isErrored(session: SessionDescriptor): boolean {
  return (
    session.status === "error" ||
    (typeof session.exitCode === "number" && session.exitCode > 0)
  )
}

export function isAwaiting(session: SessionDescriptor): boolean {
  return Boolean(session.awaitingInput || session.awaitingPermission)
}

/** Item label: `label ?? command`. */
export function labelFor(session: SessionDescriptor): string {
  return session.label ?? session.command
}

/**
 * Item description.
 *  - Without ctx (default): `adapterSlug ?? kind` + model (if any) + status —
 *    byte-identical to the pre-filter behavior existing call sites depend on.
 *  - With ctx: `workspace · relative time`, omitting any part whose backing
 *    data is absent (never a literal "undefined").
 *
 * Deliberately NOT the token counts. `+68694 -141` on every row is a raw
 * number nobody acts on — it can't be compared across sessions (different
 * models, different work) and it isn't a budget. Cost and context-fill are the
 * numbers with a decision attached, and they already live in the transcript
 * header; a tree row is for identifying a session, not auditing it. The
 * per-session totals remain in the tooltip for anyone who does want them.
 */
export function descriptionFor(session: SessionDescriptor, ctx?: DescriptionContext): string {
  if (!ctx) {
    const parts = [session.adapterSlug ?? session.kind]
    if (session.model) parts.push(session.model)
    parts.push(session.status)
    return parts.join(" · ")
  }
  const parts: string[] = []
  if (ctx.workspaceLabel) parts.push(ctx.workspaceLabel)
  if (typeof ctx.now === "number") parts.push(relativeTime(session.startedAt, ctx.now))
  return parts.join(" · ")
}

/**
 * How long a busy session may go silent before the tree stops calling it
 * healthy. Generous on purpose: `lastActivityAt` tracks ACP traffic, so a
 * single long tool call (a slow build, a big test run) legitimately goes quiet
 * for minutes and must not be branded stuck. What this catches is the other
 * shape — an agent that stopped emitting entirely and never sent `turn-end`,
 * leaving the daemon awaiting a turn that will never finish. That session sits
 * at `busy: true` forever, and a spinner claims it is working.
 */
export const STALL_AFTER_MS = 10 * 60_000

/** ms of silence for a busy session, or undefined when idle/terminal/unknown. */
export function silentForMs(session: SessionDescriptor, now: number): number | undefined {
  if (!session.busy || TERMINAL_STATUSES.has(session.status)) return undefined
  // lastActivityAt (any ACP traffic) is the truer liveness signal; lastOutputAt
  // (stdout/stderr) is the fallback for a descriptor predating it.
  const iso = session.lastActivityAt ?? session.lastOutputAt
  if (!iso) return undefined
  const last = Date.parse(iso)
  if (Number.isNaN(last)) return undefined
  return Math.max(0, now - last)
}

/** A busy session that has emitted nothing for STALL_AFTER_MS — busy in name only. */
export function isStalled(session: SessionDescriptor, now: number): boolean {
  const silent = silentForMs(session, now)
  return silent !== undefined && silent > STALL_AFTER_MS
}

/**
 * Icon by state (brief order):
 *  - terminal status (exited/killed/error) → error icon if errored, else
 *    circle-slash ("ok" exit).
 *  - non-terminal + awaiting input/permission → question (warn).
 *  - non-terminal + busy but long silent → warning: the spinner was the whole
 *    problem, telling the user a wedged session was hard at work.
 *  - non-terminal + busy → sync~spin.
 *  - non-terminal + idle → play.
 *
 * `now` is optional so existing call sites keep their behavior; without it a
 * stalled session is simply indistinguishable from a working one, as before.
 */
export function iconFor(session: SessionDescriptor, now?: number): SessionIcon {
  if (TERMINAL_STATUSES.has(session.status)) {
    return isErrored(session) ? { id: "error", color: "error" } : { id: "circle-slash" }
  }
  if (isAwaiting(session)) return { id: "question", color: "warning" }
  if (typeof now === "number" && isStalled(session, now)) {
    return { id: "warning", color: "warning" }
  }
  if (session.busy) return { id: "sync~spin" }
  return { id: "play" }
}

/** contextValue for menu gating: session-live / session-awaiting / session-done. */
export function contextValueFor(session: SessionDescriptor): SessionContextValue {
  if (TERMINAL_STATUSES.has(session.status)) return "session-done"
  if (isAwaiting(session)) return "session-awaiting"
  return "session-live"
}

/** contextUsed/contextSize as a rounded percentage string, e.g. "42%". */
export function contextPercent(used?: number, size?: number): string | undefined {
  if (typeof used !== "number" || typeof size !== "number" || size <= 0) return undefined
  return `${Math.round((used / size) * 100)}%`
}

/** Ordered tooltip fields: id, cwd, pid, startedAt, turnsCompleted, costUsd, tokensIn/Out, context %, blockedOn. */
export function tooltipFieldsFor(session: SessionDescriptor): TooltipField[] {
  const fields: TooltipField[] = [{ label: "id", value: session.id }]
  if (session.cwd) fields.push({ label: "cwd", value: session.cwd })
  fields.push({ label: "pid", value: session.pid == null ? "—" : String(session.pid) })
  fields.push({ label: "startedAt", value: session.startedAt })
  if (typeof session.turnsCompleted === "number") {
    fields.push({ label: "turns", value: String(session.turnsCompleted) })
  }
  if (typeof session.costUsd === "number") {
    fields.push({ label: "cost", value: `$${session.costUsd.toFixed(4)}` })
  }
  if (typeof session.tokensIn === "number" || typeof session.tokensOut === "number") {
    fields.push({
      label: "tokens",
      value: `${session.tokensIn ?? 0} in / ${session.tokensOut ?? 0} out`,
    })
  }
  const pct = contextPercent(session.contextUsed, session.contextSize)
  if (pct) {
    fields.push({
      label: "context",
      value: `${pct} (${session.contextUsed}/${session.contextSize})`,
    })
  }
  // Only while a turn is actually in flight: a session killed mid-tool-call
  // keeps a stale blockedOn/busy forever (the daemon clears them in the turn's
  // finally, which never runs for a generator that is never resumed), and a
  // tooltip claiming a dead session is "blockedOn: command" is just wrong.
  if (session.blockedOn && isBlocked(session)) {
    fields.push({ label: "blockedOn", value: session.blockedOn })
  }
  return fields
}

/** True only when the session is taking a turn right now — the sole state in which blockedOn means anything. */
export function isBlocked(session: SessionDescriptor): boolean {
  return Boolean(session.blockedOn) && !TERMINAL_STATUSES.has(session.status) && Boolean(session.busy)
}

/** running-first, then startedAt desc (newest first). */
export function compareSessions(a: SessionDescriptor, b: SessionDescriptor): number {
  const ra = isRunning(a)
  const rb = isRunning(b)
  if (ra !== rb) return ra ? -1 : 1
  const ta = Date.parse(a.startedAt)
  const tb = Date.parse(b.startedAt)
  if (Number.isNaN(ta) || Number.isNaN(tb)) return b.startedAt.localeCompare(a.startedAt)
  return tb - ta
}

/**
 * Group sessions into a parent/child tree: roots are sessions without a
 * (resolvable) parentSessionId; children are nested under their parent's
 * node (orchestrator subtrees). A parentSessionId pointing at an id absent
 * from the input list is treated as a root, so no session is ever dropped.
 * Every level (roots + each children array) is sorted per compareSessions.
 */
export function buildSessionTree(sessions: readonly SessionDescriptor[]): SessionNode[] {
  const byId = new Map<string, SessionNode>()
  for (const session of sessions) {
    if (!session?.id) continue
    byId.set(session.id, { session, children: [] })
  }

  const roots: SessionNode[] = []
  for (const node of byId.values()) {
    const parentId = node.session.parentSessionId
    const parent = parentId ? byId.get(parentId) : undefined
    if (parent && parent !== node) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const sortTree = (nodes: SessionNode[]): void => {
    nodes.sort((a, b) => compareSessions(a.session, b.session))
    for (const node of nodes) sortTree(node.children)
  }
  sortTree(roots)
  return roots
}

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const MS_PER_DAY = 24 * MS_PER_HOUR

/** Which side of the divider a session's `startedAt` falls on, relative to `now`. An unparsable startedAt is "older". */
export function bucketFor(session: SessionDescriptor, now: number): TimeBucket {
  const started = Date.parse(session.startedAt)
  if (Number.isNaN(started)) return "older"
  return now - started < MS_PER_DAY ? "recent" : "older"
}

/**
 * Human relative time for an ISO timestamp, e.g. "5 days ago", "2 hrs ago",
 * "just now". Clamps a negative delta (clock skew / future timestamp) to
 * "just now" rather than a nonsensical negative duration. An unparsable
 * `iso` renders as "—".
 */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return "—"
  const diffMs = Math.max(0, now - then)
  if (diffMs < 45_000) return "just now"
  const minutes = Math.floor(diffMs / MS_PER_MINUTE)
  if (minutes < 60) return `${minutes} min${minutes === 1 ? "" : "s"} ago`
  const hours = Math.floor(diffMs / MS_PER_HOUR)
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`
  const days = Math.floor(diffMs / MS_PER_DAY)
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`
  const years = Math.floor(days / 365)
  return `${years} year${years === 1 ? "" : "s"} ago`
}

export const SEPARATOR_ID = "separator-older"

/** Box-drawing rule around the divider's caption. Fixed width: a tree row can't measure the sidebar. */
const RULE = "─".repeat(8)

/**
 * Session roots as a FLAT top-level row list, with a single divider row
 * separating those started in the last 24h from the older ones.
 *
 * Recency is a top-level concern only: orchestrator subtrees
 * (parentSessionId nesting from buildSessionTree) stay intact under whichever
 * side their root lands on — a child never migrates across the divider on its
 * own `startedAt`.
 *
 * The divider is emitted ONLY when both sides are non-empty: a rule with
 * nothing above or below it separates nothing, and would just read as a
 * broken row.
 */
export function buildSessionRows(sessions: readonly SessionDescriptor[], now: number): TreeNode[] {
  const recent: SessionNode[] = []
  const older: SessionNode[] = []
  for (const root of buildSessionTree(sessions)) {
    if (bucketFor(root.session, now) === "recent") recent.push(root)
    else older.push(root)
  }

  if (recent.length === 0 || older.length === 0) return [...recent, ...older]
  const separator: SeparatorNode = {
    kind: "separator",
    id: SEPARATOR_ID,
    label: `${RULE} older than 24h ${RULE}`,
  }
  return [...recent, separator, ...older]
}

/** Compact duration for a silence window: "45s", "12min", "3h", "2d". */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
