/**
 * The ONE retirement predicate. A session is RETIRED when it is archived, its
 * `endedReason` is a deliberate end, it has a successor (`continuedTo`), or it
 * carries an explicit `retiredAt` stamp. A retired session is never revived by
 * an automated path (follow, sentinel, cron, inbound, message routing), in
 * place or under a new id; a human prompt to one with a successor is refused
 * with `session_superseded`.
 */

import { DELIBERATE_END_REASONS } from "./session-end-reason.js"
import type { SessionDescriptor } from "./sessions.js"

const SUCCESSOR_WALK_CAP = 32

export type RetirementFields = Pick<SessionDescriptor, "archived" | "endedReason" | "continuedTo" | "retiredAt">

export function isRetired(desc: Omit<RetirementFields, "endedReason"> & { endedReason?: string }): boolean {
  return (
    desc.archived === true ||
    desc.continuedTo !== undefined ||
    desc.retiredAt !== undefined ||
    (desc.endedReason !== undefined && DELIBERATE_END_REASONS.has(desc.endedReason))
  )
}

const AUTOMATED_SOURCE_RE = /^(?:session-follow|sentinel|restart|boot|cron|policy|child:|agent:)/

/** Prompt sources that are daemon- or agent-driven rather than a human at a
 *  keyboard (UI chat is `http:chat`, channels are `telegram`/…, the default
 *  is absent/`"user"` — all human). An allowlist on purpose: an unknown source
 *  stays human so a legitimate operator surface is never locked out. */
export function isAutomatedPromptSource(source: string | undefined): boolean {
  return source !== undefined && AUTOMATED_SOURCE_RE.test(source)
}

/** End of `id`'s `continuedTo` chain (followed transitively, cycle-capped),
 *  stopping at the last row that still exists. `undefined` when `id` has no
 *  existing successor. */
export function resolveSuccessor(
  get: (id: string) => RetirementFields | undefined,
  id: string,
): string | undefined {
  let current = id
  const seen = new Set<string>([id])
  for (let i = 0; i < SUCCESSOR_WALK_CAP; i++) {
    const next = get(current)?.continuedTo
    if (!next || seen.has(next) || !get(next)) break
    seen.add(next)
    current = next
  }
  return current === id ? undefined : current
}
