/**
 * Superseded-head marking for GitHub CI events.
 *
 * A push replaces a PR's head commit, but the CI that ran on the previous
 * head keeps reporting: GitHub sends `check_suite.completed` /
 * `workflow_run.completed` for the old sha minutes after the push. Forwarded
 * as-is, a watching agent reads "CI failed" about a commit that no longer
 * matters. `local-gh` never had this problem (it diffs snapshots of the
 * current head); the push paths (`webhook`, `agentpush`) forward every
 * delivery, so they converge here, in the runtime's shared per-event
 * pipeline.
 *
 * Rule: track the PR head per concrete subject (`github:o/r#N`) from every
 * `github.pull_request.*` event (each one carries the PR's current head).
 * A CI event (`check_suite`, `workflow_run`, `check_run`) whose head sha
 * differs from the tracked head is MARKED, never dropped: `data.stale`,
 * `data.current_head_sha`, a `[superseded]` summary prefix and
 * `levelHint: 1`. When the head is unknown (sentinel created after the last
 * push, an event without a sha) nothing is marked: fail open, the event is
 * delivered exactly as before.
 *
 * Pure: the caller owns persistence of the head map.
 */

import type { SentinelEvent } from "./sentinel-providers/types.js"

/** Most PR heads remembered per sentinel; oldest insertion evicted first. */
export const HEAD_SHAS_CAP = 200

export const SUPERSEDED_SUMMARY_PREFIX = "[superseded]"

const PR_SUBJECT_RE = /^github:[^/\s]+\/[^#\s]+#\d+$/
const CI_TYPE_PREFIXES = ["github.check_suite.", "github.workflow_run.", "github.check_run."] as const

/** `head_sha` (GitHub webhook spelling) or `headSha` (local-gh), or "". */
export function headShaOf(event: Pick<SentinelEvent, "data">): string {
  const raw = event.data.head_sha ?? event.data.headSha
  return typeof raw === "string" ? raw : ""
}

export function isCiEventType(type: string): boolean {
  return CI_TYPE_PREFIXES.some(prefix => type.startsWith(prefix))
}

/** The `(subject, sha)` this event reports as the PR's current head, if any. */
export function observedPrHead(event: SentinelEvent): { subject: string; sha: string } | undefined {
  if (!event.type.startsWith("github.pull_request.")) return undefined
  if (!PR_SUBJECT_RE.test(event.subject)) return undefined
  const sha = headShaOf(event)
  return sha ? { subject: event.subject, sha } : undefined
}

/** Is `eventSha` a different commit than `headSha`? Tolerates one side being
 *  an abbreviated sha (prefix match), since some producers shorten it. */
function differentCommit(eventSha: string, headSha: string): boolean {
  const a = eventSha.toLowerCase()
  const b = headSha.toLowerCase()
  return !(a.startsWith(b) || b.startsWith(a))
}

/** Already-marked events pass through untouched (a re-processed event must
 *  not get a second prefix). */
export function isSupersededEvent(event: Pick<SentinelEvent, "data">): boolean {
  return event.data.stale === true
}

/** The event marked as superseded by `currentHeadSha`. Never terminal. */
export function markSuperseded<E extends SentinelEvent>(event: E, currentHeadSha: string): E {
  return {
    ...event,
    data: { ...event.data, stale: true, current_head_sha: currentHeadSha },
    summary: `${SUPERSEDED_SUMMARY_PREFIX} ${event.summary}`,
    levelHint: 1,
    terminal: false,
  }
}

export interface HeadTrackResult<E extends SentinelEvent> {
  /** The event to deliver: the input, or its superseded-marked copy. */
  event: E
  /** The updated head map, only when this event changed it. */
  heads?: Record<string, string>
}

/**
 * Apply one event to the head map: a `pull_request.*` event records its
 * subject's head; a CI event for a different sha than the recorded head of
 * its subject is marked superseded. Everything else is returned unchanged.
 */
export function trackHead<E extends SentinelEvent>(
  event: E,
  heads: Readonly<Record<string, string>> | undefined,
): HeadTrackResult<E> {
  const known = heads ?? {}
  const observed = observedPrHead(event)
  if (observed) {
    if (known[observed.subject] === observed.sha) return { event }
    const next: Record<string, string> = { ...known }
    delete next[observed.subject] // re-insert so it is the newest entry
    next[observed.subject] = observed.sha
    const keys = Object.keys(next)
    for (const key of keys.slice(0, Math.max(0, keys.length - HEAD_SHAS_CAP))) delete next[key]
    return { event, heads: next }
  }
  if (!isCiEventType(event.type) || isSupersededEvent(event)) return { event }
  const current = known[event.subject]
  const sha = headShaOf(event)
  if (!current || !sha || !differentCommit(sha, current)) return { event }
  return { event: markSuperseded(event, current) }
}
