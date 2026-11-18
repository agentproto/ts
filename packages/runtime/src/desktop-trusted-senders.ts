/**
 * Trusted senders for the Codex Desktop direct wake (`daemon.desktopTrustedSenders`).
 *
 * By default a message from another session reaches a Codex Desktop thread as
 * DATA: it sits in an `untrusted_input` tool output and the turn text tells
 * the model to treat it as untrusted. That is the safe default, and it means
 * Codex never executes an instruction another agent sent it. This module is the
 * opt-in that lets the user say "these senders are mine": a message from one of
 * them is written into the turn text as an instruction, with the sender named.
 *
 * Policy words (same vocabulary as `defaults.messaging.labelAddressing`):
 *   - `off`      (default) nobody is trusted.
 *   - `operator` the operator's own sessions: a session the operator started
 *                (a root session, no parent, and not one that asked for
 *                `attach: false`) and a human sender (CLI / HTTP).
 *   - `tree`     `operator`, plus every session spawned beneath such a root
 *                (the whole orchestra). The lineage must resolve to such a
 *                root — a detached (`attach: false`) root anchors no tree.
 *   - a list     explicit entries: a session id (`sess_…`), `label:<operatorLabel>`
 *                (an operator-stamped label, never the display label), `human`,
 *                or the shared `claude-desktop` identity.
 *
 * Never trusted, whatever the policy: a `system` message (daemon notices carry
 * third-party text such as PR titles) and an anonymous sender. An `external`
 * session row (`cc:` / `codex:` rows are registered, not spawned by the
 * operator) is never trusted by the `operator` / `tree` modes, but a list may
 * name one explicitly — a listed id is trusted as-is. An `unverified` sender
 * (the shared `claude-desktop` identity, which any local process can claim) is
 * trusted ONLY when its id is listed explicitly; `operator` and `tree` never
 * admit it. `declaredSender` is ignored.
 */

import { z } from "zod"
import type { SessionMessageFrom } from "./session-message.js"

export type TrustedSendersMode = "off" | "operator" | "tree"
export type TrustedSenders = TrustedSendersMode | readonly string[]

export const trustedSendersSchema = z.union([z.enum(["off", "operator", "tree"]), z.array(z.string().min(1).max(200))])

/** What the policy needs to know about a sender session. */
export interface TrustedSenderSession {
  kind: string
  parentSessionId?: string
  /** The row asked for `attach: false` — a parentless root, but NOT one the
   *  operator started (see `SessionDescriptor.detached`). */
  detached?: boolean
  operatorLabel?: string
}
export type TrustedSenderLookup = (sessionId: string) => TrustedSenderSession | undefined

const MAX_LINEAGE = 32

export function normalizeTrustedSenders(value: unknown): TrustedSenders {
  if (value === "operator" || value === "tree") return value
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.length > 0)
  return "off"
}

/** The effective policy for one thread: its own entry wins over the daemon-wide one. */
export function resolveTrustedSenders(
  global: TrustedSenders | undefined,
  byThread: Readonly<Record<string, TrustedSenders>> | undefined,
  threadId: string,
): TrustedSenders {
  return byThread?.[threadId] ?? global ?? "off"
}

/** Does the lineage of `sessionId` end at a root the operator started? */
function rootedInOperator(sessionId: string, lookup: TrustedSenderLookup): boolean {
  const seen = new Set<string>()
  let id: string | undefined = sessionId
  for (let hops = 0; id !== undefined && hops < MAX_LINEAGE; hops++) {
    if (seen.has(id)) return false
    seen.add(id)
    const session = lookup(id)
    if (!session || session.kind === "external") return false
    if (session.parentSessionId === undefined) return !session.detached
    id = session.parentSessionId
  }
  return false
}

export function isTrustedSender(
  policy: TrustedSenders,
  from: Pick<SessionMessageFrom, "sessionId" | "relation" | "anonymous" | "unverified">,
  lookup: TrustedSenderLookup,
): boolean {
  if (policy === "off") return false
  if (from.anonymous || from.relation === "system") return false
  if (Array.isArray(policy)) {
    const entries = policy as readonly string[]
    if (from.relation === "human") return entries.includes("human")
    const id = from.sessionId
    if (!id) return false
    if (entries.includes(id)) return true
    if (from.unverified) return false
    const label = lookup(id)?.operatorLabel
    return label !== undefined && entries.includes(`label:${label}`)
  }
  if (from.unverified) return false
  if (from.relation === "human") return true
  const id = from.sessionId
  if (!id) return false
  if (policy === "tree") return rootedInOperator(id, lookup)
  const session = lookup(id)
  return (
    session !== undefined &&
    session.kind !== "external" &&
    session.parentSessionId === undefined &&
    !session.detached
  )
}
