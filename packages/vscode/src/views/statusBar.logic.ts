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
 *
 * A machine-origin session (isMachineOrigin, e.g. `gate` — an automated
 * push-gate reviewer) is deliberately excluded from needsYou/stalled/
 * working/idle: it's genuinely live and genuinely working, but it's the
 * gate's bookkeeping, not the operator's own work, and folding it into
 * "working" is exactly what made a 77-session gate-review pile-up read as
 * "77 things I'm mid-turn on" instead of "a leak nobody noticed". It is NOT
 * dropped, though — see `machineLive` and its `· N gate` segment in
 * buildStatusCounts, so a wedged reviewer still surfaces, just not as the
 * operator's attention. costUsd stays SUMMED across human + machine
 * sessions: a gate run still spends the operator's own API budget, so
 * excluding it from the number on screen would make the number wrong, not
 * just quieter.
 */

import type { SessionDescriptor } from "../client/types.js"
import { isMachineOrigin } from "./sessionsGroups.logic.js"
import { activityFor, type SessionActivity } from "./sessionsTree.logic.js"

export interface LiveSummary {
  /** Alive, human-origin sessions — the operator's own agents, and the only
   *  ones folded into needsYou/stalled/working/idle below (a finished
   *  session is history either way, so only "the process is up" counts as
   *  alive at all). */
  live: SessionDescriptor[]
  /** Alive machine-origin sessions (isMachineOrigin) — counted and exposed
   *  separately so a wedged automated reviewer stays visible without being
   *  mistaken for the operator's own work. */
  machineLive: SessionDescriptor[]
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
  const allLive = sessions.filter(isLive)
  const live = allLive.filter(s => !isMachineOrigin(s.origin))
  const machineLive = allLive.filter(s => isMachineOrigin(s.origin))
  const summary: LiveSummary = {
    live,
    machineLive,
    needsYou: 0,
    stalled: 0,
    working: 0,
    idle: 0,
    costUsd: allLive.reduce((sum, s) => sum + (s.costUsd ?? 0), 0),
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
 * Idle is always shown when there are live (human) sessions at all, so the
 * bar never implies the daemon is empty when it isn't.
 *
 * A trailing `N gate` segment reports `machineLive` — always present when
 * non-zero, even when every human count above it is zero, so a stalled
 * automated reviewer is never silently dropped just because nothing else is
 * going on.
 */
export function buildStatusCounts(summary: LiveSummary): string {
  const parts: string[] = []
  if (summary.live.length === 0) {
    parts.push("no sessions")
  } else {
    if (summary.needsYou > 0) parts.push(`${summary.needsYou} need${summary.needsYou === 1 ? "s" : ""} you`)
    if (summary.stalled > 0) parts.push(`${summary.stalled} stuck`)
    if (summary.working > 0) parts.push(`${summary.working} working`)
    if (summary.idle > 0) parts.push(`${summary.idle} idle`)
  }
  if (summary.machineLive.length > 0) parts.push(`${summary.machineLive.length} gate`)
  return parts.join(" · ")
}

/** The full status-bar text, icon excluded. */
export function buildStatusText(summary: LiveSummary): string {
  const counts = buildStatusCounts(summary)
  if (summary.live.length === 0 && summary.machineLive.length === 0) return `agentproto: ${counts}`
  return `agentproto: ${counts} · $${summary.costUsd.toFixed(2)}`
}
