/**
 * Session-owner gate for the MCP drive tools (`agent_prompt`,
 * `agent_interrupt`, `agent_kill`, `session_restart`,
 * `session_continue_fresh`).
 *
 * The owner of a session is the caller that spawned it — that session's
 * `parentSessionId` — or the human operator for a root spawn. Calls coming
 * from ANOTHER agent session are refused, unless the session's
 * `allowPromptFrom` list names the caller (session ids, or the wildcard
 * `"any"`). The operator connects without a `callerSessionId` and always
 * passes the gate.
 *
 * Enforcement lives in the daemon tool handlers (agent-tools.ts /
 * session-tools.ts), NOT in the mount's `?denyTools=` query alone: the same
 * gate then applies to any daemon serving these tools over MCP — the host
 * daemon and a box daemon inside a sandbox box alike — so a session's role
 * is enforced consistently regardless of which daemon's mount it reaches.
 */

import type { SessionDescriptor } from "./sessions.js"

/** The caller of a drive-tool call: an operator (no caller session), or a
 *  named agent session (the trusted `callerSessionId`). */
export type PromptCaller = string | "operator"

/** The effective CALLING session id for this `/mcp` request: the scoped
 *  orchestrator gateway's verified scope first, else the trusted
 *  `?callerSessionId=` query. Precedence matches spawn attribution
 *  (`agent_prompt`'s `promptSource`). `undefined` ⇒ human operator. */
export function effectiveCallerSessionId(
  callerScope: { ownerSessionId: string } | undefined,
  callerSessionId: string | undefined,
): string | undefined {
  return callerScope?.ownerSessionId ?? callerSessionId
}

/** A callerSessionId-sized label for session events: the calling session's
 *  id, or `"operator"` when the call carried no caller session (CLI/HTTP/UI
 *  operators connect without one). */
export function promptCallerLabel(callerSessionId: string | undefined): PromptCaller {
  return callerSessionId ?? "operator"
}

/** Why the owner gate refused (or passed) a call. */
export type OwnerGateResult =
  | { ok: true }
  | { ok: false; message: string }

/**
 * Decide a drive-tool call against the session-owner model. Pure (no fs, no
 * registry). Rules, in order:
 *
 *  1. Human operator (no caller session): allowed — full rights, unchanged.
 *  2. The session itself: allowed — a session driving its own lifecycle
 *     (self-restart, self-interrupt) was always a legal self-action.
 *  3. Its OWNER — the session that spawned it (`parentSessionId`): allowed;
 *     this is what keeps every existing parent→child flow working.
 *  4. The session's `allowPromptFrom` list (session ids, or `"any"`):
 *     allowed — an explicitly granted secondary caller.
 *  5. Everything else (a session that is not the owner, not listed): refused
 *     with a pointed error.
 */
export function checkSessionOwnerGate(input: {
  /** Effective calling session id, or undefined for the human operator. */
  callerSessionId: string | undefined
  /** The target session's descriptor. */
  target: Pick<SessionDescriptor, "id" | "parentSessionId" | "allowPromptFrom">
  /** MCP tool name, for the error text. */
  tool: string
}): OwnerGateResult {
  const { callerSessionId, target, tool } = input
  if (callerSessionId === undefined) return { ok: true }
  if (callerSessionId === target.id) return { ok: true }
  if (target.parentSessionId && callerSessionId === target.parentSessionId) {
    return { ok: true }
  }
  const allow = target.allowPromptFrom ?? []
  if (allow.includes("any") || allow.includes(callerSessionId)) return { ok: true }
  const owner =
    target.parentSessionId ??
    "the operator (the session was spawned at the root, so the human operator is its owner)"
  return {
    ok: false,
    message:
      `${tool}: session "${target.id}" may only be driven by its owner — ` +
      `the session that spawned it (${owner}) — by the human operator, or by ` +
      `a caller explicitly granted access via \`allowPromptFrom\`. ` +
      `This call came from session "${callerSessionId}", which is none of those.`,
  }
}

/** Uniform refusal shape for MCP tool handlers. */
export function ownerGateError(tool: string, message: string): {
  content: { type: "text"; text: string }[]
  isError: true
} {
  return {
    content: [{ type: "text", text: `${message}` }],
    isError: true,
  }
}

/**
 * Does `caller` have the right to CHANGE a session's `allowPromptFrom`
 * list? Only the session's owner (its parent), the session itself, or the
 * human operator may.
 */
export function checkPromptPolicyEditor(input: {
  callerSessionId: string | undefined
  target: Pick<SessionDescriptor, "id" | "parentSessionId">
}): OwnerGateResult {
  const { callerSessionId, target } = input
  if (callerSessionId === undefined) return { ok: true }
  if (
    callerSessionId === target.id ||
    (target.parentSessionId && callerSessionId === target.parentSessionId)
  ) {
    return { ok: true }
  }
  return {
    ok: false,
    message: `session "${target.id}"'s prompt policy may only be changed by the session that spawned it, by the session itself, or by the human operator — this call came from session "${callerSessionId}".`,
  }
}
