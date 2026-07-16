/**
 * Pure status-bar summarisation — NO vscode import, so the one line that is
 * on screen permanently is unit-testable.
 *
 * The old line read `9 running ▸ 0 busy`, which was true and useless: nine
 * agents were alive, none were doing anything, and "running" is the LIFECYCLE
 * axis (the process is up) rendered where a reader takes it for the ACTIVITY
 * axis (something is happening). "9 running" says work is underway. Nothing
 * was underway.
 *
 * So this counts activity (see sessionsTree.logic.ts's SessionActivity), and
 * leads with the most demanding bucket — a status bar is glanced at, not read,
 * and the glance should answer "does anything need me?" before anything else.
 */

import type { SessionDescriptor } from "../client/types.js"
import { activityFor, type SessionActivity } from "./sessionsTree.logic.js"

export interface LiveSummary {
  /** Alive sessions (the only ones counted — a finished session is history). */
  live: SessionDescriptor[]
  needsYou: number
  stalled: number
  working: number
  idle: number
  costUsd: number
}

/** Alive = the process is up. Everything else here is about what it's DOING. */
function isLive(session: SessionDescriptor): boolean {
  return session.status === "running" || session.status === "starting"
}

export function summarizeLive(
  sessions: readonly SessionDescriptor[],
  now: number,
): LiveSummary {
  const live = sessions.filter(isLive)
  const summary: LiveSummary = {
    live,
    needsYou: 0,
    stalled: 0,
    working: 0,
    idle: 0,
    costUsd: live.reduce((sum, s) => sum + (s.costUsd ?? 0), 0),
  }
  for (const session of live) {
    switch (activityFor(session, now)) {
      case "needs-you":
        summary.needsYou++
        break
      case "stalled":
        summary.stalled++
        break
      case "working":
        summary.working++
        break
      default:
        // A live session can only be idle here — the terminal activities are
        // unreachable for anything isLive() accepted.
        summary.idle++
    }
  }
  return summary
}

/**
 * The most demanding thing currently true — drives the icon, so the bar's
 * glyph is a claim about whether you're needed rather than decoration. The
 * old `$(pulse)` throbbed identically whether nine agents were mid-turn or
 * fast asleep.
 */
export function dominantActivity(summary: LiveSummary): SessionActivity {
  if (summary.needsYou > 0) return "needs-you"
  if (summary.stalled > 0) return "stalled"
  if (summary.working > 0) return "working"
  return "idle"
}

/** Codicon id (no `$()`) for the bar, matching the tree's alphabet. */
export function statusBarIcon(summary: LiveSummary): string {
  switch (dominantActivity(summary)) {
    case "needs-you":
      return "question"
    case "stalled":
      return "warning"
    case "working":
      return "loading~spin"
    default:
      return "circle-filled"
  }
}

/**
 * Counts, most urgent first, zeroes omitted. "9 idle" alone is the honest
 * reading of nine parked agents; "1 working · 8 idle" says what changed.
 * Idle is always shown when there are live sessions at all, so the bar never
 * implies the daemon is empty when it isn't.
 */
export function buildStatusCounts(summary: LiveSummary): string {
  if (summary.live.length === 0) return "no sessions"
  const parts: string[] = []
  if (summary.needsYou > 0) parts.push(`${summary.needsYou} need${summary.needsYou === 1 ? "s" : ""} you`)
  if (summary.stalled > 0) parts.push(`${summary.stalled} stuck`)
  if (summary.working > 0) parts.push(`${summary.working} working`)
  if (summary.idle > 0) parts.push(`${summary.idle} idle`)
  return parts.join(" · ")
}

/** The full status-bar text, icon excluded. */
export function buildStatusText(summary: LiveSummary): string {
  const counts = buildStatusCounts(summary)
  if (summary.live.length === 0) return `agentproto: ${counts}`
  return `agentproto: ${counts} · $${summary.costUsd.toFixed(2)}`
}
