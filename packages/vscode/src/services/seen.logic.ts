/**
 * Pure read-receipt logic — NO vscode import. seen.ts wraps this over a
 * Memento so the rules stay unit-testable under plain vitest.
 *
 * The sessions tree paints a session's idle dot from these rules: filled means
 * "this session produced output you haven't looked at", hollow means "nothing
 * new". That is a different question from what a session IS (see
 * SessionActivity) — a parked session is parked whether or not you've read it
 * — so unread lives on its own axis rather than becoming another activity.
 */

import type { SessionDescriptor } from "../client/types.js"

/** sessionId → epoch ms at which the operator last had eyes on its output. */
export type SeenMap = Record<string, number>

/**
 * How many read-receipts to keep. The daemon's session list is its whole
 * history, so an unbounded map would grow for the life of the install. Evicting
 * the least-recently-read is safe in the only direction that matters: a
 * forgotten session reverts to unread (filled), which overstates novelty rather
 * than hiding it.
 */
export const SEEN_MAX_ENTRIES = 500

/** `lastOutputAt` as epoch ms, or undefined when absent/unparseable. */
export function lastOutputMs(session: SessionDescriptor): number | undefined {
  const iso = session.lastOutputAt
  if (!iso) return undefined
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * Has this session produced output the operator hasn't seen?
 *
 * Never looked at it ⇒ unread. That is the honest reading of "you haven't seen
 * this", and it's the safe default besides: the failure mode of guessing unread
 * is a dot that stays filled until you open the session, whereas guessing read
 * silently hides new output — which is the whole thing the dot exists to
 * surface. A session that has never emitted anything has nothing to read, so
 * it's neither.
 */
export function isUnread(session: SessionDescriptor, seenAt: number | undefined): boolean {
  const produced = lastOutputMs(session)
  if (produced === undefined) return false
  if (seenAt === undefined) return true
  return produced > seenAt
}

/** Drop the least-recently-read entries beyond SEEN_MAX_ENTRIES. */
export function pruneSeen(map: SeenMap, max = SEEN_MAX_ENTRIES): SeenMap {
  const entries = Object.entries(map)
  if (entries.length <= max) return map
  entries.sort((a, b) => b[1] - a[1])
  return Object.fromEntries(entries.slice(0, max))
}

/**
 * Record that the operator has eyes on `sessionId` as of `at`.
 *
 * Returns the same object when the receipt would move backwards — replaying an
 * older mark must not un-read newer output.
 */
export function markSeen(map: SeenMap, sessionId: string, at: number): SeenMap {
  const prev = map[sessionId]
  if (prev !== undefined && prev >= at) return map
  return pruneSeen({ ...map, [sessionId]: at })
}
