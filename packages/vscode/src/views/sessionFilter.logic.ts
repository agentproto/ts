/**
 * Pure sessions-tree filter state + predicate logic — NO vscode import so
 * it's unit-testable under plain vitest. sessionFilter.ts wires the
 * interactive QuickPick/InputBox commands that mutate this state;
 * sessionsTree.ts calls filterSessions() on the live session list before
 * handing survivors to buildSessionRows() — filter first, then lay out the
 * survivors, so the recency divider is decided from what's actually shown
 * and filtering can never leave a rule with nothing on one side of it.
 *
 * SessionFilterState's shape is frozen (WP3 reads it) — do not reshape.
 */

import type { SessionDescriptor, SessionSummary, WorkspacesConfig } from "../client/types.js"
import { workspaceLabelFor } from "../services/workspaces.logic.js"
import { activityFor, type SessionActivity } from "./sessionsTree.logic.js"

export interface SessionFilterState {
  status: ("live" | "awaiting" | "done" | "stopped" | "failed")[]
  workspaces: string[]
  adapters: string[]
  search: string
}

export const EMPTY_FILTER: SessionFilterState = {
  status: [],
  workspaces: [],
  adapters: [],
  search: "",
}

export function isFilterActive(state: SessionFilterState): boolean {
  return (
    state.status.length > 0 ||
    state.workspaces.length > 0 ||
    state.adapters.length > 0 ||
    state.search.trim().length > 0
  )
}

const STATUS_TO_ACTIVITIES: Record<
  SessionFilterState["status"][number],
  readonly SessionActivity[]
> = {
  live: ["working", "idle", "stalled"],
  awaiting: ["needs-you"],
  done: ["done"],
  stopped: ["stopped"],
  failed: ["failed"],
}

function matchesStatus(session: SessionDescriptor, status: readonly SessionFilterState["status"][number][]): boolean {
  if (status.length === 0) return true
  const activity = activityFor(session) // no `now`: stalled folds into working, which is under "live" anyway
  return status.some(s => STATUS_TO_ACTIVITIES[s].includes(activity))
}

function matchesWorkspace(
  session: SessionDescriptor,
  workspaces: readonly string[],
  config: WorkspacesConfig,
): boolean {
  if (workspaces.length === 0) return true
  const label = workspaceLabelFor(config, session)
  return label !== undefined && workspaces.includes(label)
}

function matchesAdapter(session: SessionDescriptor, adapters: readonly string[]): boolean {
  if (adapters.length === 0) return true
  return adapters.includes(session.adapterSlug ?? session.kind)
}

function matchesSearch(session: SessionDescriptor, search: string): boolean {
  const term = search.trim().toLowerCase()
  if (!term) return true
  const haystack = [session.label, session.command, session.cwd, session.id]
    .filter((v): v is string => typeof v === "string")
    .join("\n")
    .toLowerCase()
  return haystack.includes(term)
}

function matchesFilter(session: SessionDescriptor, state: SessionFilterState, config: WorkspacesConfig): boolean {
  return (
    matchesStatus(session, state.status) &&
    matchesWorkspace(session, state.workspaces, config) &&
    matchesAdapter(session, state.adapters) &&
    matchesSearch(session, state.search)
  )
}

/**
 * Filter sessions by status/workspace/adapter/search (state) against the
 * given workspace config.
 *
 * Parent-retention rule: a session that itself fails every predicate is
 * still kept when one of its descendants (transitively, by
 * parentSessionId) survives — otherwise an orchestrator subtree collapses
 * once sessionsTree.logic.ts's buildSessionTree re-nests the filtered list,
 * and the matching child becomes unreachable. Applies uniformly to every
 * predicate, including search.
 */
export function filterSessions<T extends SessionSummary>(
  sessions: readonly T[],
  state: SessionFilterState,
  config: WorkspacesConfig,
): T[] {
  if (!isFilterActive(state)) return [...sessions]

  const matched = new Set<string>()
  for (const session of sessions) {
    if (session.id && matchesFilter(session, state, config)) matched.add(session.id)
  }
  if (matched.size === 0) return []

  const childrenByParent = new Map<string, T[]>()
  for (const session of sessions) {
    const parentId = session.parentSessionId
    if (!parentId) continue
    const list = childrenByParent.get(parentId)
    if (list) list.push(session)
    else childrenByParent.set(parentId, [session])
  }

  // Memoized with a false placeholder set before recursing so a cyclical
  // parentSessionId chain (should one ever occur) terminates instead of
  // recursing forever.
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

/** Every distinct adapter identity (adapterSlug ?? kind) present in a session list, sorted — for the filter picker. */
export function adapterIdentitiesIn(sessions: readonly SessionDescriptor[]): string[] {
  const ids = new Set<string>()
  for (const session of sessions) ids.add(session.adapterSlug ?? session.kind)
  return [...ids].sort((a, b) => a.localeCompare(b))
}

/**
 * Short human summary of the active filter, e.g.
 * `status: live · workspace: Agentik Studio · search: "sales"` — for the
 * tree view's `description`. Empty string when the filter is inactive.
 */
export function filterSummary(state: SessionFilterState): string {
  const parts: string[] = []
  if (state.status.length > 0) parts.push(`status: ${state.status.join(", ")}`)
  if (state.workspaces.length > 0) parts.push(`workspace: ${state.workspaces.join(", ")}`)
  if (state.adapters.length > 0) parts.push(`adapter: ${state.adapters.join(", ")}`)
  const search = state.search.trim()
  if (search) parts.push(`search: "${search}"`)
  return parts.join(" · ")
}
