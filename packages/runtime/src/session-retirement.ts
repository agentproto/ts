/**
 * The ONE retirement predicate. A session is RETIRED when it is archived, its
 * `endedReason` is a deliberate end, it has a successor (`continuedTo`), or it
 * carries an explicit `retiredAt` stamp. A retired session is never revived by
 * an automated path (follow, sentinel, cron, message routing), in place or
 * under a new id; a human prompt to one with a successor is refused with
 * `session_superseded` (wire: 409 `session_not_alive` + `reason`).
 *
 * Inbound (WhatsApp / Telegram / agentpush) is the one exception to "retired
 * ⇒ never revived", because an inbound message is a real human:
 *   - a row with `continuedTo` routes to its successor (end of the chain);
 *   - any other retired row may be revived IN PLACE (same id);
 *   - an ARCHIVED row is never revived under a NEW id — the message is parked
 *     with a log line instead (`makeRestartForRouting`, `routeInboundMessage`).
 */

import { DELIBERATE_END_REASONS } from "./session-end-reason.js"
import type { SessionEndReason } from "./session-end-reason.js"
import type { SessionDescriptor, SessionsRegistry } from "./sessions.js"

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

const AUTOMATED_SOURCE_RE =
  /^(?:session-follow|sentinel|restart|boot|cron|policy|workflow|daemon:|child:|agent:)/

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

export interface RetireSessionInput {
  /** Successor session (id or name). Sets `continuedTo` and re-points the
   *  retired row's follows and session-targeted sentinels at it in place. */
  successor?: string
  /** `"completed"` → `operator-completed`; anything else → `operator-stopped`. */
  reason?: string
}

export type RetireSessionResult =
  | {
      ok: true
      id: string
      /** The row was alive and this call stopped it. */
      killed: boolean
      retiredAt?: string
      endedReason?: string
      continuedTo?: string
    }
  | { ok: false; status: 400 | 404; error: string; message: string }

/** Stamp `id` retired (and, with a successor, superseded). Works on alive rows
 *  (stopped first) and terminal rows; idempotent. Follow/sentinel re-pointing
 *  rides on the registry's `onSessionRetired` event (`retirement-cleanup.ts`). */
export function retireSession(
  registry: Pick<SessionsRegistry, "get" | "findByIdOrName" | "kill" | "markRetired">,
  id: string,
  input: RetireSessionInput = {},
): RetireSessionResult {
  const desc = registry.get(id)
  if (!desc) return { ok: false, status: 404, error: "session_not_found", message: `session "${id}" not found` }

  let successorId: string | undefined
  if (input.successor !== undefined) {
    const successor = registry.findByIdOrName(input.successor)
    if (!successor) {
      return { ok: false, status: 404, error: "successor_not_found", message: `successor "${input.successor}" not found` }
    }
    if (successor.id === id) {
      return { ok: false, status: 400, error: "invalid_successor", message: "a session cannot succeed itself" }
    }
    // The successor's own chain must not lead back to `id`.
    let cursor: string | undefined = successor.id
    for (let i = 0; cursor && i < SUCCESSOR_WALK_CAP; i++) {
      if (cursor === id) {
        return { ok: false, status: 400, error: "successor_cycle", message: `"${successor.id}" already continues into "${id}"` }
      }
      cursor = registry.get(cursor)?.continuedTo
    }
    successorId = successor.id
  }

  const wasAlive = desc.status === "running" || desc.status === "starting"
  const endReason: SessionEndReason = input.reason === "completed" ? "operator-completed" : "operator-stopped"
  const killed = registry.kill(id, undefined, endReason)
  const after = registry.markRetired(id, { cause: "killed", ...(successorId ? { continuedTo: successorId } : {}) }) ?? desc
  return {
    ok: true,
    id,
    killed: wasAlive && killed,
    ...(after.retiredAt ? { retiredAt: after.retiredAt } : {}),
    ...(after.endedReason ? { endedReason: after.endedReason } : {}),
    ...(after.continuedTo ? { continuedTo: after.continuedTo } : {}),
  }
}
