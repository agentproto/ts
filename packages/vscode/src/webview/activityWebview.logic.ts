/**
 * Pure Activity-WEBVIEW row/group model — NO vscode import, so it's
 * unit-testable under plain vitest (activityWebviewPanel.ts wraps this into
 * the webview's HTML/postMessage payload, same split as
 * sessionsWebview.logic.ts vs. sessionsWebviewPanel.ts).
 *
 * The Activity panel is the read-only "what is the daemon doing" surface. It
 * consumes the daemon's Activity projection (`GET /activities`, a
 * deterministic recomputed-on-every-call read model over turns, policies,
 * gates, commits, workflow steps, PRs and cron runs) and the shell sessions
 * the Sessions panel no longer carries: PTY terminals (`kind === "terminal"`)
 * and raw command executions (`kind === "command"`).
 *
 * Vocabulary (docs/PANEL-ENTITIES.md — non-negotiable):
 *   - `pending` here means BLOCKED ON AN EXTERNAL SIGNAL (`waitingOn` names
 *     it) — never "unclaimed" (that is Task's pending, a different panel).
 *   - Read-only by construction: no action buttons, no writes. The only
 *     interaction is opening a terminal/command session, reusing the same
 *     command the Sessions panel uses.
 */

import type { ActivityRecord, SessionSummary } from "../client/types.js"
import { sessionDisplayName } from "../client/sessionName.js"

/** Newest terminal-state activities kept across the whole model. */
export const TERMINAL_ACTIVITY_CAP = 20

/** One rendered activity row — flat, read-only, no action. */
export interface ActivityRow {
  /** The activity's deterministic projection id (`policy:x`, `turn:s:y:3`). */
  id: string
  kind: string
  state: string
  title: string
  /** The human sentence naming the blocker — present only while pending. */
  waitingOn: string | undefined
  /** Relative age from `now`, e.g. "4m ago". */
  age: string
  /** True when the owner calls this active but it has been silent (`staleSince`). */
  stale: boolean
  /** The session this row sits under — the host resolves clicks by it (terminal/command rows only). */
  sessionId: string | undefined
  /** Terminal-state (done/failed/cancelled) — renders dimmed. */
  terminal: boolean
}

/** One collapsible group: a subject session's activities, or a shell-sessions bucket. */
export interface ActivityGroup {
  key: string
  label: string
  rows: ActivityRow[]
}

export interface ActivityWebviewModel {
  groups: ActivityGroup[]
  shownCount: number
}

/** State rank for the within-group order: active, then pending, then terminal. */
function stateRank(state: string): number {
  if (state === "active") return 0
  if (state === "pending") return 1
  return 2
}

function isTerminalState(state: string): boolean {
  return state === "done" || state === "failed" || state === "cancelled"
}

/** Relative age of an ISO timestamp from `now` — "just now" / "4m ago" / "3h ago" / "6d ago". Undefined when the timestamp is unparseable (a malformed payload must not throw). */
export function relativeAgeFrom(iso: unknown, now: number): string {
  if (typeof iso !== "string" && typeof iso !== "number") return ""
  const ms = typeof iso === "number" ? iso : Date.parse(iso)
  if (!Number.isFinite(ms)) return ""
  const age = Math.max(0, now - ms)
  if (age < 60_000) return "just now"
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`
  return `${Math.floor(age / 86_400_000)}d ago`
}

/**
 * One human sentence naming the blocker. `waitingOn.detail` wins when present;
 * otherwise the sentence derives from `kind` (and its `refs` count for
 * `session-turn`). EVERY one of the six kinds produces text; a malformed
 * payload (null / non-object / unknown kind) degrades to "waiting" rather
 * than throwing or returning an empty string.
 */
export function waitingOnText(waitingOn: unknown): string {
  if (!waitingOn || typeof waitingOn !== "object") return "waiting"
  const { kind, detail, refs } = waitingOn as { kind?: unknown; detail?: unknown; refs?: unknown }
  if (typeof detail === "string" && detail.trim().length > 0) return detail.trim()
  const refCount = Array.isArray(refs) ? refs.length : 0
  switch (kind) {
    case "session-turn":
      return refCount > 1 ? `waiting on ${refCount} session turns` : "waiting on a session turn"
    case "human-ack":
      return "waiting on a human ack"
    case "cap-slot":
      return "waiting on a free policy slot"
    case "stage-barrier":
      return "waiting on a stage barrier"
    case "forge":
      return "waiting on the forge"
    case "timer":
      return "waiting on a timer"
    default:
      return "waiting"
  }
}

/** The activity's subject session id — `sessionId`, falling back to the first of `sessionIds` (the fan-in group's head). */
function subjectIdOf(rec: ActivityRecord): string | undefined {
  return rec?.sessionId ?? (Array.isArray(rec?.sessionIds) ? rec.sessionIds[0] : undefined)
}

function rowFor(rec: ActivityRecord, now: number): ActivityRow {
  const terminal = rec.state !== "active" && rec.state !== "pending"
  return {
    id: typeof rec.id === "string" ? rec.id : "",
    kind: rec.kind,
    state: rec.state,
    title: typeof rec.title === "string" ? rec.title : "",
    waitingOn: rec.state === "pending" ? waitingOnText((rec as { waitingOn?: unknown }).waitingOn) : undefined,
    age: relativeAgeFrom(rec.startedAt, now),
    stale: typeof rec.staleSince === "string",
    sessionId: subjectIdOf(rec),
    terminal,
  }
}

/** Newest-first, ties broken by the deterministic id so equal timestamps stay stable. */
function byNewest(a: { startedAt?: unknown; id?: unknown }, b: { startedAt?: unknown; id?: unknown }): number {
  const aMs = typeof a.startedAt === "string" ? Date.parse(a.startedAt) : Number.NaN
  const bMs = typeof b.startedAt === "string" ? Date.parse(b.startedAt) : Number.NaN
  const aT = Number.isFinite(aMs) ? aMs : 0
  const bT = Number.isFinite(bMs) ? bMs : 0
  if (bT !== aT) return bT - aT
  return String(a.id ?? "").localeCompare(String(b.id ?? ""))
}

/** Map a shell session's status to an activity-ish state for the Terminals/Commands buckets. */
function shellStateFor(session: SessionSummary): string {
  if (session.status === "exited") return (session.exitCode ?? 0) === 0 ? "done" : "failed"
  if (session.status === "killed") return "cancelled"
  if (session.status === "error") return "failed"
  return "active"
}

function shellRowFor(session: SessionSummary, now: number): ActivityRow {
  const state = shellStateFor(session)
  return {
    id: session.id,
    kind: session.kind,
    state,
    title: sessionDisplayName(session),
    waitingOn: undefined,
    age: relativeAgeFrom(session.startedAt, now),
    stale: false,
    sessionId: session.id,
    terminal: state !== "active",
  }
}

/**
 * The webview's single entry point. Groups, in this order:
 *   1. one group PER SUBJECT session (labelled with the session's display
 *      name), rows newest-first with active before pending before terminal;
 *   2. a "Terminals" group — the PTY (`kind === "terminal"`) sessions, newest first;
 *   3. a "Commands" group — the `kind === "command"` sessions with no parent
 *      session present to sit under.
 * Terminal-state activities are capped at the newest
 * {@link TERMINAL_ACTIVITY_CAP} across the WHOLE model. Malformed input
 * (non-arrays, null records) yields an empty row, never a throw; empty input
 * yields an empty model.
 */
export function buildActivityWebviewModel(input: {
  activities: readonly ActivityRecord[] | undefined
  sessions: readonly SessionSummary[] | undefined
  now: number
}): ActivityWebviewModel {
  const activities = Array.isArray(input.activities) ? input.activities : []
  const sessions = (Array.isArray(input.sessions) ? input.sessions : []).filter(
    (s): s is SessionSummary => s !== null && typeof s === "object",
  )
  const now = input.now

  const byId = new Map(sessions.map(s => [s.id, s]))

  const buckets = new Map<string, { label: string; rows: ActivityRow[] }>()
  const valid = activities.filter((r): r is ActivityRecord => r !== null && typeof r === "object")
  const recordById = new Map(valid.map(r => [String(r.id ?? ""), r]))
  for (const rec of valid) {
    const subject = subjectIdOf(rec)
    if (!subject) continue
    const session = byId.get(subject)
    const label = session ? sessionDisplayName(session) : subject
    let bucket = buckets.get(subject)
    if (!bucket) {
      bucket = { label, rows: [] }
      buckets.set(subject, bucket)
    }
    bucket.rows.push(rowFor(rec, now))
  }

  const groups: ActivityGroup[] = []
  for (const [key, bucket] of buckets) {
    const rows = bucket.rows.slice().sort((a, b) => {
      const byState = stateRank(a.state) - stateRank(b.state)
      if (byState !== 0) return byState
      return byNewest(recordById.get(a.id)!, recordById.get(b.id)!)
    })
    groups.push({ key, label: bucket.label, rows })
  }

  // Terminal cap, applied globally BEFORE grouping so a long-lived daemon
  // never paints thousands of rows: keep the newest 20 terminal rows across
  // all groups, drop the rest.
  const terminalIds = new Set(
    valid
      .filter(r => r.state !== "active" && r.state !== "pending")
      .sort(byNewest)
      .slice(TERMINAL_ACTIVITY_CAP)
      .map(r => String(r.id)),
  )

  // Terminals — the PTY sessions, newest first.
  const terminals = sessions
    .filter(s => s.kind === "terminal")
    .slice()
    .sort(byNewest)
  if (terminals.length > 0) {
    groups.push({
      key: "terminals",
      label: "Terminals",
      rows: terminals.map(s => shellRowFor(s, now)),
    })
  }

  // Commands — raw command executions with no parent session to sit under.
  const commands = sessions
    .filter(s => s.kind === "command" && (!s.parentSessionId || !byId.has(s.parentSessionId)))
    .sort(byNewest)
  if (commands.length > 0) {
    groups.push({
      key: "commands",
      label: "Commands",
      rows: commands.map(s => shellRowFor(s, now)),
    })
  }

  const capped = groups.map(g => ({ ...g, rows: g.rows.filter(r => !terminalIds.has(r.id)) }))
  const nonEmpty = capped.filter(g => g.rows.length > 0)
  return { groups: nonEmpty, shownCount: nonEmpty.reduce((n, g) => n + g.rows.length, 0) }
}
