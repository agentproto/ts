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
 *
 * Trust note: the gate is keyed on the daemon-trusted `?callerSessionId=`
 * identity — the same claim every other MCP tool keys on — not an
 * independent proof of the calling process.
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
  callerScope: { ownerSessionId?: string } | undefined,
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

/**
 * Does a grant list (`allowPromptFrom`, `defaults.tasks.operatorDelegates`, …)
 * name this session? Exact session ids match directly; `label:` entries match
 * ONLY the caller's immutable operator-assigned `operatorLabel` — an exact
 * `label:<label>` or a `label:<prefix>*` wildcard — and `label:` / `label:*`
 * (empty prefix) match nothing. The mutable `label` never matches.
 */
export function matchesSessionGrant(
  entries: readonly string[],
  sessionId: string,
  operatorLabelOf: (id: string) => string | undefined,
): boolean {
  if (entries.includes(sessionId)) return true
  const callerLabel = operatorLabelOf(sessionId)
  if (!callerLabel) return false
  for (const entry of entries) {
    if (!entry.startsWith("label:")) continue
    const pattern = entry.slice("label:".length)
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1)
      if (prefix !== "" && callerLabel.startsWith(prefix)) return true
    } else if (pattern !== "" && callerLabel === pattern) {
      return true
    }
  }
  return false
}

/** Why the owner gate refused (or passed) a call. */
export type OwnerGateResult =
  | { ok: true }
  | { ok: false; message: string }

/**
 * Decide a drive-tool call against the session-owner model. Pure (no fs).
 * Rules, in order:
 *
 *  1. Human operator (no caller session): allowed — full rights, unchanged.
 *  2. The session itself: allowed — a session driving its own lifecycle
 *     (self-restart, self-interrupt) was always a legal self-action.
 *  3. Its OWNER — the session that spawned it (`parentSessionId`): allowed;
 *     this is what keeps every existing parent→child flow working.
 *  4. AN ANCESTOR of the target in its `parentSessionId` chain (grand-
 *     parents, orchestrator roots): allowed — ancestor control of spawned
 *     descendants was already the scoped-orchestrator behavioral contract
 *     (subtree gates on `agent_kill`/`session_restart`), so the owner gate
 *     must not revoke it. Pass `parentOf` to enable the walk.
 *  5. The session's `allowPromptFrom` list (session ids, `"any"`, or
 *     `label:<operatorLabel>` / `label:<prefix>*` grants): allowed — an
 *     explicitly granted secondary caller. A `label:` entry matches ONLY a
 *     caller's operator-assigned `operatorLabel` (normally stamped by the
 *     daemon when the operator spawned a root session; the human operator
 *     may re-stamp it via `agent_set_operator_label`, but no *session* can
 *     change it) and only when that caller has no parent. The mutable
 *     `label` (settable by the session itself via `session_rename`, or by
 *     any spawner) never matches, and `label:` / `label:*` (empty prefix)
 *     match nothing.
 *  6. Everything else (a session that is neither an ancestor/owner nor
 *     listed): refused with a pointed error.
 */
export function checkSessionOwnerGate(input: {
  /** Effective calling session id, or undefined for the human operator. */
  callerSessionId: string | undefined
  /** The target session's descriptor. */
  target: Pick<SessionDescriptor, "id" | "parentSessionId" | "allowPromptFrom">
  /** MCP tool name, for the error text. */
  tool: string
  /** Resolves a session's `parentSessionId` (registry lookup) — enables the
   *  ancestor-chain rule above. Optional; tests may pass none.
   *  `operatorLabelOf` resolves a session's operator-assigned `operatorLabel`
   *  (registry lookup) — enables `label:` entries in `allowPromptFrom`.
   *  Optional; tests may pass none. */
  parentOf?: (id: string) => string | undefined
  operatorLabelOf?: (id: string) => string | undefined
}): OwnerGateResult {
  const { callerSessionId, target, tool, parentOf, operatorLabelOf } = input
  if (callerSessionId === undefined) return { ok: true }
  if (callerSessionId === target.id) return { ok: true }
  if (target.parentSessionId && callerSessionId === target.parentSessionId) {
    return { ok: true }
  }
  if (parentOf && target.parentSessionId) {
    let ancestor: string | undefined = target.parentSessionId
    for (let i = 0; i < 256 && ancestor; i++) {
      if (ancestor === callerSessionId) return { ok: true }
      ancestor = parentOf(ancestor)
    }
  }
  const allow = target.allowPromptFrom ?? []
  if (allow.includes("any") || allow.includes(callerSessionId)) return { ok: true }
  if (operatorLabelOf && !parentOf?.(callerSessionId)) {
    if (matchesSessionGrant(allow, callerSessionId, operatorLabelOf)) return { ok: true }
  }
  const owner =
    target.parentSessionId ??
    "the operator (the session was spawned at the root, so the human operator is its owner)"
  return {
    ok: false,
    message:
      `${tool}: session "${target.id}" may only be driven by its owner — ` +
      `the session that spawned it (${owner}) — one of its ancestors in the ` +
      `spawn tree, by the human operator, or by a caller explicitly granted ` +
      `access via \`allowPromptFrom\`. This call came from session ` +
      `"${callerSessionId}", which is none of those.`,
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
