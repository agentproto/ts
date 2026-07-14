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

/** Item description: `adapterSlug ?? kind` + model (if any) + status. */
export function descriptionFor(session: SessionDescriptor): string {
  const parts = [session.adapterSlug ?? session.kind]
  if (session.model) parts.push(session.model)
  parts.push(session.status)
  return parts.join(" · ")
}

/**
 * Icon by state (brief order):
 *  - terminal status (exited/killed/error) → error icon if errored, else
 *    circle-slash ("ok" exit).
 *  - non-terminal + awaiting input/permission → question (warn).
 *  - non-terminal + busy → sync~spin.
 *  - non-terminal + idle → play.
 */
export function iconFor(session: SessionDescriptor): SessionIcon {
  if (TERMINAL_STATUSES.has(session.status)) {
    return isErrored(session) ? { id: "error", color: "error" } : { id: "circle-slash" }
  }
  if (isAwaiting(session)) return { id: "question", color: "warning" }
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
  if (session.blockedOn) fields.push({ label: "blockedOn", value: session.blockedOn })
  return fields
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
