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
 * Rule: "stale" means the CI event's head sha is a KNOWN SUPERSEDED sha of
 * its PR, never merely "different from the head I last saw". Per concrete
 * PR subject (`github:o/r#N`) we keep the current head plus a small bounded
 * set of superseded shas, learned from `github.pull_request.*` events: a
 * `synchronize` adds its `before` sha, and any head change adds the
 * previously recorded head. GitHub does not order separate webhook
 * deliveries, so a CI event for a sha never seen before (typically the NEW
 * head whose `synchronize` has not arrived yet) is NOT marked: fail open.
 * Marking only ever demotes, so it must never fire on a sha that could be
 * the live head.
 *
 * A marked event is never dropped: `data.stale`, `data.current_head_sha`
 * (when known), a `[superseded]` summary prefix and `levelHint: 1`. A
 * subject's entry is removed when its terminal event (PR closed/merged) is
 * processed.
 *
 * Pure: the caller owns persistence of the state map.
 */

import type { SentinelEvent } from "./sentinel-providers/types.js"

/** Per-PR head state: the last known head and the shas it superseded. */
export interface PrHeadState {
  head?: string
  superseded: string[]
}

export type PrHeads = Record<string, PrHeadState>

/** Most PR subjects remembered per sentinel; oldest insertion evicted first. */
export const PR_HEADS_CAP = 200
/** Most superseded shas remembered per PR; oldest evicted first. */
export const SUPERSEDED_SHAS_CAP = 20

export const SUPERSEDED_SUMMARY_PREFIX = "[superseded]"

const PR_SUBJECT_RE = /^github:[^/\s]+\/[^#\s]+#\d+$/
const ZERO_SHA_RE = /^0+$/
// `check_run.*` is deliberately absent: the normalizer never emits it
// (design §4), so listing it would only advertise unexercised support.
const CI_TYPE_PREFIXES = ["github.check_suite.", "github.workflow_run."] as const

function shaField(value: unknown): string {
  return typeof value === "string" && value.length > 0 && !ZERO_SHA_RE.test(value) ? value : ""
}

/** `head_sha` (GitHub webhook spelling) or `headSha` (local-gh), or "". */
export function headShaOf(event: Pick<SentinelEvent, "data">): string {
  return shaField(event.data.head_sha ?? event.data.headSha)
}

export function isCiEventType(type: string): boolean {
  return CI_TYPE_PREFIXES.some(prefix => type.startsWith(prefix))
}

function isPrSubjectEvent(event: SentinelEvent): boolean {
  return event.type.startsWith("github.pull_request.") && PR_SUBJECT_RE.test(event.subject)
}

/** Same commit? Tolerates one side being an abbreviated sha (prefix match). */
function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x.startsWith(y) || y.startsWith(x)
}

/** Already-marked events pass through untouched (a re-processed event must
 *  not get a second prefix). */
export function isStaleCiEvent(event: Pick<SentinelEvent, "data">): boolean {
  return event.data.stale === true
}

/** The event marked as superseded. Never terminal. */
export function markSuperseded<E extends SentinelEvent>(event: E, currentHeadSha?: string): E {
  return {
    ...event,
    data: { ...event.data, stale: true, ...(currentHeadSha ? { current_head_sha: currentHeadSha } : {}) },
    summary: `${SUPERSEDED_SUMMARY_PREFIX} ${event.summary}`,
    levelHint: 1,
    terminal: false,
  }
}

export interface HeadTrackResult<E extends SentinelEvent> {
  /** The event to deliver: the input, or its superseded-marked copy. */
  event: E
  /** The updated state map, only when this event changed it. */
  heads?: PrHeads
}

function withEntry(known: PrHeads, subject: string, entry: PrHeadState | undefined): PrHeads {
  const next: PrHeads = { ...known }
  delete next[subject] // re-insert so it is the newest entry
  if (entry) next[subject] = entry
  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - PR_HEADS_CAP))) delete next[key]
  return next
}

function learnFromPullRequest(event: SentinelEvent, prev: PrHeadState | undefined): PrHeadState | undefined {
  const sha = headShaOf(event)
  const before = shaField(event.data.before)
  let superseded = [...(prev?.superseded ?? [])]
  const supersede = (old: string): void => {
    if (!old || (sha && sameCommit(old, sha)) || superseded.some(s => sameCommit(s, old))) return
    superseded.push(old)
  }
  if (prev?.head && sha && !sameCommit(prev.head, sha)) supersede(prev.head)
  supersede(before)
  // A force-push back to an older commit makes it the head again.
  if (sha) superseded = superseded.filter(s => !sameCommit(s, sha))
  const head = sha || prev?.head
  if (!head && superseded.length === 0) return prev
  return { ...(head ? { head } : {}), superseded: superseded.slice(-SUPERSEDED_SHAS_CAP) }
}

function sameState(a: PrHeadState | undefined, b: PrHeadState | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * Apply one event to the state map. A `pull_request.*` event updates its
 * subject's head and superseded set (a terminal one removes the subject); a
 * CI event whose head sha is a known superseded sha of its subject is
 * marked. Everything else is returned unchanged.
 */
export function trackHead<E extends SentinelEvent>(
  event: E,
  heads: Readonly<PrHeads> | undefined,
): HeadTrackResult<E> {
  const known: PrHeads = heads ?? {}
  if (isPrSubjectEvent(event)) {
    const prev = known[event.subject]
    if (event.terminal === true) {
      return prev ? { event, heads: withEntry(known, event.subject, undefined) } : { event }
    }
    const next = learnFromPullRequest(event, prev)
    if (sameState(prev, next)) return { event }
    return { event, heads: withEntry(known, event.subject, next) }
  }
  if (!isCiEventType(event.type) || isStaleCiEvent(event)) return { event }
  const entry = known[event.subject]
  const sha = headShaOf(event)
  if (!entry || !sha) return { event }
  if (entry.head && sameCommit(sha, entry.head)) return { event }
  if (!entry.superseded.some(s => sameCommit(s, sha))) return { event }
  return { event: markSuperseded(event, entry.head) }
}
