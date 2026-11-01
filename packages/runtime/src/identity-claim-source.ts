/**
 * WHICH CLIENT MADE THE CLAIM-ONLY REQUEST (ts#2165 step 5 follow-up).
 *
 * `GET /identity` counts claim-only requests by class, and enforce mode
 * refuses the `delivered` ones, but the observation said nothing about who
 * the caller was or how it carried the claim. A plain claude-code session
 * was observed reconnecting without its token about eleven minutes after
 * start, and without a client label nobody could tell whether that was the
 * harness rebuilding the transport from the URL, an SSE re-open or a hook.
 * This module is the pure labeler: the client (first User-Agent product
 * token), the HTTP verb, and the carrier of the claim. Observation only, no
 * request is handled differently.
 */

export type ClaimCarrier = "query" | "header" | "both"

export interface ClaimSource {
  client: string
  verb: string
  carrier: ClaimCarrier
}

export interface ClaimSourceInput {
  method: string | undefined
  userAgent: string | string[] | undefined
  hasQueryClaim: boolean
  hasHeaderClaim: boolean
}

/** Distinct source keys kept in one counter; a new key past this lands in
 *  `other`, which does not count toward the bound (so at most 33 keys). */
export const CLAIM_SOURCE_KEYS_MAX = 32

const CLIENT_MAX = 32
const KNOWN_VERBS: ReadonlySet<string> = new Set(["GET", "POST", "DELETE", "PUT", "PATCH", "HEAD", "OPTIONS"])

/** The first product token of a User-Agent: cut at the first `/`, space or
 *  `(`, lowercased, stripped of characters outside `[a-z0-9._-]` and
 *  truncated to 32. `none` when the header is absent or empty, `other` when
 *  nothing survives the cleaning. */
function clientOf(userAgent: string | string[] | undefined): string {
  const raw = Array.isArray(userAgent) ? userAgent[0] : userAgent
  if (raw === undefined || raw === "") return "none"
  const cut = raw.split(/[/ (]/, 1)[0] ?? ""
  const cleaned = cut
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, CLIENT_MAX)
  return cleaned === "" ? "other" : cleaned
}

function verbOf(method: string | undefined): string {
  if (method === undefined) return "other"
  const verb = method.toUpperCase()
  return KNOWN_VERBS.has(verb) ? verb : "other"
}

/** Label one claim-only request. The caller only builds a source when a
 *  claim exists, so with neither flag the carrier reads `header`. */
export function claimSourceOf(input: ClaimSourceInput): ClaimSource {
  const carrier: ClaimCarrier =
    input.hasQueryClaim && input.hasHeaderClaim ? "both" : input.hasQueryClaim ? "query" : "header"
  return { client: clientOf(input.userAgent), verb: verbOf(input.method), carrier }
}

/** `"<client> <verb> <carrier>"`, the counter key and the tail of the log
 *  line. */
export function claimSourceKey(source: ClaimSource): string {
  return `${source.client} ${source.verb} ${source.carrier}`
}

/** Increment the counter for `source`, bounding the distinct source keys:
 *  a new key past {@link CLAIM_SOURCE_KEYS_MAX} increments `other` instead,
 *  while an existing key keeps counting normally. */
export function bumpClaimSource(counts: Record<string, number>, source: ClaimSource): void {
  const key = claimSourceKey(source)
  if (key in counts) {
    counts[key] = (counts[key] ?? 0) + 1
    return
  }
  if (Object.keys(counts).length >= CLAIM_SOURCE_KEYS_MAX) {
    counts.other = (counts.other ?? 0) + 1
    return
  }
  counts[key] = 1
}
