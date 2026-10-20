/**
 * Pure continue-fresh lineage helpers for the sessions tree — NO vscode
 * import. A fresh continuation keeps the previous session's label and title
 * verbatim; the lineage is shown SEPARATELY: a small `↻ N` row segment (how
 * many continuation hops) plus a tooltip naming the previous session, and an
 * action that opens the previous session in the chain.
 */

import type { SessionDescriptor } from "../client/types.js"

export interface ContinuationLookup {
  (id: string): SessionDescriptor | undefined
}

/** Maximum hops walked when counting by chaining `continuedFrom` ids — a
 *  safety cap for a corrupted (cyclic) lineage; real chains are tiny. */
const MAX_CHAIN_WALK = 128

/**
 * Previous session in the continuation chain: the descriptor whose id is
 * `continuedFrom`, when present in `lookup`. Undefined on a base row (no
 * `continuedFrom`) or when the previous session isn't known (absent from the
 * store, e.g. archived-but-hidden or forgotten).
 */
export function previousContinuationSession(
  session: Pick<SessionDescriptor, "continuedFrom">,
  lookup: ContinuationLookup,
): SessionDescriptor | undefined {
  if (!session.continuedFrom) return undefined
  return lookup(session.continuedFrom)
}

/**
 * How many continuation hops this row is from its lineage's start. Prefer the
 * descriptor's `continuationGeneration` (stamped by the daemon); fall back to
 * walking `continuedFrom` ids through `lookup` — the walk is CAPPED at
 * MAX_CHAIN_WALK rather than cycle-checked (a cyclic lineage reports the cap,
 * not a detected cycle), an unknown `continuedFrom` id still counts as one hop
 * (the row IS a continuation even if the predecessor is off-list).
 * Returns undefined on a base row.
 */
export function continuationCount(
  session: Pick<SessionDescriptor, "continuedFrom" | "continuationGeneration">,
  lookup?: ContinuationLookup,
): number | undefined {
  if (!session.continuedFrom) return undefined
  if (typeof session.continuationGeneration === "number") {
    return Math.max(1, session.continuationGeneration)
  }
  if (!lookup) return undefined
  let hops = 0
  let current: SessionDescriptor | undefined = { ...session } as SessionDescriptor
  while (current?.continuedFrom && hops < MAX_CHAIN_WALK) {
    hops += 1
    current = lookup(current.continuedFrom)
  }
  return hops
}

/**
 * The tree-row badge segment: `↻ 3` (one per continuation hop), or undefined
 * on a base row / a row whose count can't be determined.
 */
export function continuationBadgeFor(
  session: Pick<SessionDescriptor, "continuedFrom" | "continuationGeneration">,
  lookup?: ContinuationLookup,
): string | undefined {
  const count = continuationCount(session, lookup)
  return count === undefined ? undefined : `↻ ${count}`
}

/** Id tail used to tell two same-named sessions apart — session ids are
 *  `sess_<hex>`, so the tail is the distinguishing part (same convention as
 *  the transcript's `from <shortId>` chips). */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(-6) : id
}

/**
 * Previous session's display name for the tooltip: its human label when known,
 * otherwise its raw id (lineage must stay traceable even when the predecessor
 * is no longer in the store). The label/title is followed by the id tail:
 * continue-fresh copies names VERBATIM, so `previous: <label>` alone would
 * name the predecessor with the exact string this row shows as its own.
 */
export function previousSessionTitle(
  previous: SessionDescriptor | undefined,
  continuedFrom: string | undefined,
): string | undefined {
  if (previous) {
    const name = previous.label ?? previous.title
    if (name === undefined) return previous.id
    return `${name} (${shortId(previous.id)})`
  }
  return continuedFrom
}

/**
 * Full tooltip line: `Continued 3 times — previous: <prev label or id> (id
 * tail)`, or undefined on a base row.
 */
export function continuationTooltipFor(
  session: Pick<SessionDescriptor, "continuedFrom" | "continuationGeneration">,
  lookup?: ContinuationLookup,
): string | undefined {
  if (!session.continuedFrom) return undefined
  const count = continuationCount(session, lookup)
  const prev = previousSessionTitle(
    lookup?.(session.continuedFrom),
    session.continuedFrom,
  )
  const times =
    count === undefined ? "Continued" : `Continued ${count} ${count === 1 ? "time" : "times"}`
  return `${times} — previous: ${prev}`
}
