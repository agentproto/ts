/**
 * Pure sessions-tree filter state + predicate logic — NO vscode import so
 * it's unit-testable under plain vitest. sessionFilter.ts wires the
 * interactive QuickPick/InputBox commands that mutate this state;
 * sessionsTree.ts calls filterSessions() on the live session list before
 * handing survivors to buildSessionRows() — filter first, then lay out the
 * survivors, so the recency divider is decided from what's actually shown
 * and filtering can never leave a rule with nothing on one side of it.
 *
 * SessionFilterState's EXISTING fields are frozen (WP3 reads them) — do not
 * rename, retype, or drop `status`/`workspaces`/`adapters`/`search`. A NEW
 * dimension (like `origin` below) is additive, not a reshape — but it MUST
 * be optional: state persisted in ctx.workspaceState from before the field
 * existed round-trips through `JSON`/VS Code's storage with the key simply
 * absent, not `undefined`-valued, so every reader treats it as
 * `state.origin ?? []` and never assumes presence.
 */

import type { SessionDescriptor, SessionSummary, WorkspacesConfig } from "../client/types.js"
import { workspaceLabelFor } from "../services/workspaces.logic.js"
import { isMachineOrigin, UNKNOWN_ORIGIN_SLUG } from "./sessionsGroups.logic.js"
import { activityFor, type SessionActivity } from "./sessionsTree.logic.js"

export interface SessionFilterState {
  status: ("live" | "awaiting" | "done" | "stopped" | "failed")[]
  workspaces: string[]
  adapters: string[]
  /** Origin dimension — matches the raw origin slug (`"gate"`,
   *  `"claude-code"`, … or UNKNOWN_ORIGIN_SLUG for an originless session),
   *  not the friendly label. OPTIONAL — see the file-level doc comment. */
  origin?: string[]
  search: string
}

export const EMPTY_FILTER: SessionFilterState = {
  status: [],
  workspaces: [],
  adapters: [],
  origin: [],
  search: "",
}

export function isFilterActive(state: SessionFilterState): boolean {
  return (
    state.status.length > 0 ||
    state.workspaces.length > 0 ||
    state.adapters.length > 0 ||
    (state.origin?.length ?? 0) > 0 ||
    state.search.trim().length > 0
  )
}

const STATUS_TO_ACTIVITIES: Record<
  SessionFilterState["status"][number],
  readonly SessionActivity[]
> = {
  live: ["working", "idle", "stalled", "parked-bg"],
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

function matchesOrigin(session: SessionDescriptor, origins: readonly string[]): boolean {
  if (origins.length === 0) return true
  return origins.includes(session.origin ?? UNKNOWN_ORIGIN_SLUG)
}

/**
 * agentproto.hideMachineSessions default: excludes a machine-origin session
 * (isMachineOrigin) UNLESS the operator set an explicit origin filter — an
 * explicit choice always wins over the default, whether that choice
 * includes `gate` or not (either way `matchesOrigin` above already decided
 * the right thing for the origins the operator actually picked).
 */
function passesMachineDefault(
  session: SessionDescriptor,
  state: SessionFilterState,
  hideMachineSessions: boolean,
): boolean {
  if (!hideMachineSessions) return true
  if ((state.origin?.length ?? 0) > 0) return true
  return !isMachineOrigin(session.origin)
}

/**
 * Token-AND: the query is split on whitespace and every non-empty token must
 * appear somewhere in the haystack (case-insensitive substring). A token still
 * can't span two fields — the `\n` join is a deliberate separator, not just a
 * delimiter. Fuzzy/subsequence matching is out of scope; see the PR description.
 */
function matchesSearch(session: SessionDescriptor, search: string): boolean {
  const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const haystack = [session.label, session.command, session.cwd, session.id]
    .filter((v): v is string => typeof v === "string")
    .join("\n")
    .toLowerCase()
  return tokens.every(token => haystack.includes(token))
}

function matchesFilter(
  session: SessionDescriptor,
  state: SessionFilterState,
  config: WorkspacesConfig,
  hideMachineSessions: boolean,
): boolean {
  return (
    matchesStatus(session, state.status) &&
    matchesWorkspace(session, state.workspaces, config) &&
    matchesAdapter(session, state.adapters) &&
    matchesOrigin(session, state.origin ?? []) &&
    matchesSearch(session, state.search) &&
    passesMachineDefault(session, state, hideMachineSessions)
  )
}

export interface FilterSessionsOptions {
  /** agentproto.hideMachineSessions (default true in package.json) — default
   *  out machine-origin sessions (isMachineOrigin) unless the operator set
   *  an explicit origin filter. Off here by default so a caller that omits
   *  it (e.g. an older test) keeps today's behavior unchanged. */
  hideMachineSessions?: boolean
}

/**
 * Filter sessions by status/workspace/adapter/origin/search (state) against
 * the given workspace config, and — via `options.hideMachineSessions` —
 * the machine-origin default described above.
 *
 * Parent-retention rule: a session that itself fails every predicate is
 * still kept when one of its descendants (transitively, by
 * parentSessionId) survives — otherwise an orchestrator subtree collapses
 * once sessionsTree.logic.ts's buildSessionTree re-nests the filtered list,
 * and the matching child becomes unreachable. Applies uniformly to every
 * predicate, including search and the machine-origin default.
 */
export function filterSessions<T extends SessionSummary>(
  sessions: readonly T[],
  state: SessionFilterState,
  config: WorkspacesConfig,
  options: FilterSessionsOptions = {},
): T[] {
  const hideMachineSessions = options.hideMachineSessions ?? false
  // The default applies only while the operator hasn't already made an
  // explicit origin choice — same rule as passesMachineDefault, checked here
  // too so an all-machine session list with no other active filter doesn't
  // take the "nothing is filtering, return everything" fast path below.
  const machineDefaultActive = hideMachineSessions && (state.origin?.length ?? 0) === 0
  if (!isFilterActive(state) && !machineDefaultActive) return [...sessions]

  const matched = new Set<string>()
  for (const session of sessions) {
    if (session.id && matchesFilter(session, state, config, hideMachineSessions)) matched.add(session.id)
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

/** Every distinct origin slug (origin ?? UNKNOWN_ORIGIN_SLUG) present in a
 *  session list, sorted — for the filter picker. Mirrors adapterIdentitiesIn;
 *  the picker maps each raw slug through originLabelFor for display. */
export function originIdentitiesIn(sessions: readonly SessionDescriptor[]): string[] {
  const ids = new Set<string>()
  for (const session of sessions) ids.add(session.origin ?? UNKNOWN_ORIGIN_SLUG)
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
  if ((state.origin?.length ?? 0) > 0) parts.push(`origin: ${(state.origin ?? []).join(", ")}`)
  const search = state.search.trim()
  if (search) parts.push(`search: "${search}"`)
  return parts.join(" · ")
}
