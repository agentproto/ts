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
  // The host guard reaped an idle session through `POST /sessions/:id/reap`
  // (never the operator `/kill` route). Distinct from `idle-reaped` so the
  // UI/log can tell a periodic-watchdog retirement from the daemon's own
  // idle reaper; like `idle-reaped` it leaves the row lazy-resumable and is
  // excluded from eager resume-on-boot (which gates on `daemon-restart`).
  "guard-reaped",
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
  // A detached sandbox session's box no longer exists on its provider when
  // the host daemon came back (expired, reaped, deleted) — the reattach pass
  // could not reconnect it. Distinct from `daemon-restart`: nothing survived.
  "sandbox_gone",
  // An E2B-style box whose lifetime expired on schedule while the session
  // was idle: the box's lifetime is a per-renew runway, the proxy deliberately
  // leaves an idle box to expire, and the provider reaps it exactly at that
  // deadline (or at the plan-level lifetime cap). Expected expiry, NOT a
  // crash — the row ends `status: "exited"` with its work branch (already
  // checkpointed/pushed) surfaced in the outcome's artifacts
  // (`sandbox-agent-session-proxy.ts`'s `SandboxBoxExpiredError`).
  "sandbox-expired",
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
// hosted plans (e.g. opencode Go) phrase the same cap as "Go usage limit exceeded"
// (AI_APICallError on its stderr stream).
const PROVIDER_LIMIT_ERROR_RE = /\bhit your (?:session|usage) limit\b|\busage limit (?:exceeded|reached)\b/i

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

// Opaque driver failures that carry no cause of their own ("Internal error",
// "RequestError: Internal error"). Deliberately narrow: a message with any
// further detail (a status code, a provider cause) is NOT generic, and its
// own words are the classification — only a bare wrapper is worth a second
// look at the turn's assistant text.
const GENERIC_TURN_ERROR_RE = /^\s*(?:[A-Za-z][\w.]*:\s*)?internal error\s*[.!]?\s*$/i

/** True when `message` is an opaque generic turn error. See
 *  {@link GENERIC_TURN_ERROR_RE}. */
export function isGenericTurnError(message: string | undefined): boolean {
  return message !== undefined && GENERIC_TURN_ERROR_RE.test(message)
}

/**
 * Recover a provider-limit message from the turn's own assistant text.
 *
 * Some adapters (notably Codex via codex-acp) print the subscription cap as a
 * final assistant message, then fail the turn with a bare "Internal error".
 * The driver error says nothing, so the text is the only evidence. Only
 * consulted when the error is {@link isGenericTurnError} — a specific error
 * is never overridden by prose — and only the narrow
 * {@link PROVIDER_LIMIT_ERROR_RE} wording matches, as a single line.
 * Returns `undefined` when no such line exists.
 */
export function providerLimitFromTurnText(
  errorMessage: string | undefined,
  assistantText: string | undefined,
): string | undefined {
  if (!isGenericTurnError(errorMessage) || assistantText === undefined) return undefined
  const line = assistantText.split(/\r?\n/).find(l => isProviderLimitError(l))
  return line?.trim() || undefined
}

/**
 * Name the wallet a usage-cap error was billed to. The adapter only says
 * e.g. "usage limit exceeded"; with several profiles/sub-accounts the operator
 * needs to know WHICH one is spent (profile, plus the pinned sub-account). Non-limit messages and sessions with no
 * named profile pass through untouched.
 */
export function tagLimitErrorWithWallet(
  message: string,
  accessProfile:
    | { profileRef: string; label?: string; subaccount?: { kind: string; id: string; name?: string } }
    | undefined,
): string {
  if (!accessProfile || !isProviderLimitError(message) || message.includes("[wallet:")) return message
  const label = accessProfile.label ? ` — ${accessProfile.label}` : ""
  const sub = accessProfile.subaccount
  const scope = sub ? `, ${sub.kind} "${sub.name ?? sub.id}"` : ""
  return `${message} [wallet: profile "${accessProfile.profileRef}"${label}${scope}]`
}

/** End reasons that mean the session was closed on purpose (or that it was
 *  superseded by a living replacement) — no AUTOMATED path (sentinel, follow,
 *  cron) may revive such a row. An explicit `session_restart` / human prompt
 *  still may. `guard-reaped` belongs here: the guard retires an idle row and
 *  a later explicit prompt can resume it in place, but nothing should wake it
 *  automatically (least of all the boot pass, which already gates on
 *  `daemon-restart`). */
export const DELIBERATE_END_REASONS: ReadonlySet<string> = new Set([
  "operator-completed",
  "operator-stopped",
  "steward-completed",
  "steward-abandoned",
  // Superseded by a fresh-id restart continuation while still alive.
  "restarted",
  // The host guard's periodic reap (`POST /sessions/:id/reap`).
  "guard-reaped",
])
