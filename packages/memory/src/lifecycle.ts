import type { MemoryFrontmatter, MemoryStatus } from "./types.js"

/** The item's status, reading an absent `status` as `active` (rule 9). */
export function memoryStatus(doc: Pick<MemoryFrontmatter, "status">): MemoryStatus {
  return doc.status ?? "active"
}

/**
 * Rule 7: a writer only moves `status` from `active` (or absent) to
 * `superseded` or `archived`, and never out of either. Rewriting the
 * same status is not a transition and is allowed.
 */
export function isAllowedStatusTransition(
  from: MemoryStatus | undefined,
  to: MemoryStatus,
): boolean {
  const current = from ?? "active"
  return current === to || current === "active"
}

/**
 * Whether a reader may present the item as in force at `now`.
 *
 * Rule 10: a `superseded` or `archived` item is not. Rule 11: an
 * `until` lifetime past its `at` is not. A `while` anchor or a
 * `session` lifetime needs context outside the document (does the
 * anchor still hold, which session is current), so this check treats
 * them as holding; the store that has that context narrows further.
 */
export function isInForce(
  doc: Pick<MemoryFrontmatter, "status" | "lifetime">,
  now: Date = new Date(),
): boolean {
  if (memoryStatus(doc) !== "active") return false
  const lifetime = doc.lifetime
  if (lifetime?.kind === "until" && lifetime.at !== undefined) {
    return Date.parse(lifetime.at) > now.getTime()
  }
  return true
}
