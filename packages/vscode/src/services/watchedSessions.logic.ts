/**
 * Pure watched-session transition logic — NO vscode import, so the rules for
 * WHICH activity change earns a notification stay unit-testable under plain
 * vitest. watchedSessions.ts wraps this into the vscode.Memento-persisted
 * service + the toast itself; this module only decides WHEN one fires.
 *
 * The whole point of watching a session is to be told the moment it stalls,
 * needs you, parks with background work pending, fails, or finishes — the
 * states a parked session would otherwise sit in silently forever. Anything
 * quieter (working → idle churn) is exactly the noise a watcher is meant to
 * filter out.
 */

import type { SessionActivity } from "../views/sessionsTree.logic.js"

/** The activities a watched session TRANSITIONS INTO that earn a notification. */
export type WatchNotificationKind = "warning" | "info"

/** One notification to raise: which session, what it became, and how loud. */
export interface WatchTransition {
  sessionId: string
  activity: SessionActivity
  kind: WatchNotificationKind
}

/**
 * The last activity each watched session was seen in. Persisted alongside the
 * watched-ids set so a reload doesn't re-fire every watched session's current
 * state as a "transition".
 */
export type WatchActivityMap = Readonly<Record<string, SessionActivity>>

const WARNING_ACTIVITIES = new Set<SessionActivity>(["needs-you", "stalled", "parked-bg"])
const INFO_ACTIVITIES = new Set<SessionActivity>(["done", "failed"])

/** The notification kind for a transition INTO `activity`, or undefined when
 *  the state is not one a watcher cares about (idle/working churn). */
export function notificationKindFor(activity: SessionActivity): WatchNotificationKind | undefined {
  if (WARNING_ACTIVITIES.has(activity)) return "warning"
  if (INFO_ACTIVITIES.has(activity)) return "info"
  return undefined
}

/**
 * Diff the previous per-session activities against the current ones, returning
 * one transition per (session, state) change that deserves a toast.
 *
 * Debounce rule: a session re-entering the SAME activity it was already in is
 * NOT a transition — only a genuine change of state is. A session absent from
 * `previous` (first sighting after a reload) transitions only when its current
 * activity is a notifiable one — we don't invent a quiet "was idle" baseline.
 *
 * `previous` maps session id → last known activity; `current` maps session id
 * → current activity, only for sessions still present. A watched session that
 * vanished from the store simply produces no transition (it has no activity
 * to report).
 */
export function detectWatchTransitions(
  previous: WatchActivityMap,
  current: Readonly<Record<string, SessionActivity>>,
): WatchTransition[] {
  const transitions: WatchTransition[] = []
  for (const [sessionId, activity] of Object.entries(current)) {
    const before = previous[sessionId]
    if (before === activity) continue
    const kind = notificationKindFor(activity)
    if (kind) transitions.push({ sessionId, activity, kind })
  }
  return transitions
}
