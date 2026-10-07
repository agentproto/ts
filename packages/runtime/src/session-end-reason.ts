/**
 * The single place every stable `SessionDescriptor.endedReason` /
 * `SessionOutcome.termination.reason` value is declared, so a UI can render
 * a label for each one without chasing the call site that set it.
 *
 * Two families:
 *   - operator-issued — set ONLY by an explicit `POST /sessions/:id/kill`
 *     or the `agent_kill` MCP tool, distinguishing an operator's deliberate
 *     stop from every automatic teardown below;
 *   - internal/automatic — set by the daemon itself, without an operator
 *     in the loop, for a reason the operator couldn't have expressed.
 *
 * Backward compatible by construction: this is a value list, not a closed
 * validator. A descriptor persisted by an older daemon (or a newer one an
 * older UI doesn't know about yet) carries a `reason` string outside this
 * list — {@link isKnownSessionEndReason} says so, and callers should fall
 * back to a generic label rather than throw.
 */
export const SESSION_END_REASONS = [
  // Pre-existing automatic daemon-lifecycle reasons (unchanged).
  "daemon-restart",
  "idle-reaped",
  "crashed",
  // Operator-issued kill (HTTP /sessions/:id/kill, agent_kill MCP tool).
  // `operator-stopped` is also the default when the operator's kill omitted
  // an explicit reason — still tagged so it reads as deliberate, not random.
  "operator-completed",
  "operator-stopped",
  // Internal/automatic teardown reasons.
  "cost-cap-exceeded",
  // Context-continuity hard-stop: the window filled past `hardStopAtPct`
  // and the session was closed to avoid running on a truncated context.
  "context-hard-stop",
  "policy-cleanup",
  "parent-exited",
  "provider-limit",
  "forgotten",
  // Session steward (FIX-9A) — a deterministic/judged close via
  // `registry.closeWithOutcome`, never a plain `kill()`.
  "steward-completed", // verdict:"done" — the steward closed it as finished work.
  "steward-abandoned", // verdict other than "done" — the steward closed it as not completed.
  // `restartAgentSession` (session-restart-core.ts) minted a fresh-id
  // continuation while this row was still alive (running/starting) — the
  // OLD row is superseded (see its `continuedTo`) and closed cleanly here,
  // never left running alongside its replacement. Deliberate, not a crash:
  // never eligible for `restart-scheduler.ts`'s crash-restart (status is
  // "killed", not "error") and never triggers `notifyParentOnCrash`
  // (`supervisor-notify.ts` gates on `status:"error"`/`reason:"crashed"`).
  "restarted",
] as const

export type SessionEndReason = (typeof SESSION_END_REASONS)[number]

/** True when `reason` is one of {@link SESSION_END_REASONS}. A label
 *  lookup, not a wire-format gate — an unrecognized string is still a
 *  valid `endedReason` from a daemon version this build doesn't know
 *  about; callers should render it with a generic fallback, never reject
 *  it. */
export function isKnownSessionEndReason(reason: string | undefined): reason is SessionEndReason {
  return reason !== undefined && (SESSION_END_REASONS as readonly string[]).includes(reason)
}

// Deliberately narrow: matches Claude Code's own wording for a
// subscription/usage cap ("You've hit your session limit …" / "…usage
// limit …") rather than any error mentioning "limit" in passing (a rate
// limit on one tool call, a context-window limit, etc.) — those are
// ordinary turn errors, not "this session is dead until the cap resets".
const PROVIDER_LIMIT_ERROR_RE = /\bhit your (?:session|usage) limit\b/i

/**
 * Classify a driver-reported error message as a provider/subscription
 * usage cap rather than an ordinary tool/turn failure. Used wherever the
 * daemon would otherwise tag a dead session with the generic `"crashed"` /
 * `"error"` reason, so an operator sees "wait for your quota to reset"
 * instead of chasing a phantom bug.
 */
export function isProviderLimitError(message: string | undefined): boolean {
  return message !== undefined && PROVIDER_LIMIT_ERROR_RE.test(message)
}
