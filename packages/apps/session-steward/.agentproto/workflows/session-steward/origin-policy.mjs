// Pure origin policy for the session steward: whether a candidate session may
// be CLOSED or only FLAGGED is a function of its provenance, so it is a real
// function here — no I/O, no clock, no daemon state. Imported by entry.mjs
// (the WORKFLOW.md step graph) and pinned by unit tests. The workflow inputs
// `userOrigins` / `closableOrigins` configure it; the defaults below are the
// committed policy: a human is in the loop, so a human-launched session is
// never closed autonomously.

/** Origins the steward must NEVER close — a human launched the session, so a
 *  close is always downgraded to a flag. Exact match, or a trailing `*`. */
export const DEFAULT_USER_ORIGINS = ["chat-starter", "vscode"]
/** Origins the steward MAY close under the current rules. `cron:*` matches
 *  every cron-spawned job (`origin: "cron:<jobId>"`); `gate` matches
 *  supervision-gate sessions. */
export const DEFAULT_CLOSABLE_ORIGINS = ["cron:*", "gate"]

/** The reason shown (and recorded) when a would-be close is bounded by origin. */
export const USER_ORIGIN_REASON = "flag (origine utilisateur)"

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0

/** One origin-list entry vs a session's origin. A trailing `*` is a prefix
 *  wildcard (`cron:*` matches `cron:kill-idle-sessions`); otherwise exact. */
export function matchesOrigin(origin, pattern) {
  if (!isNonEmptyString(origin) || !isNonEmptyString(pattern)) return false
  const p = pattern.trim()
  if (p.endsWith("*")) return origin.startsWith(p.slice(0, -1))
  return origin === p
}

/** Fold raw (possibly absent/empty/malformed) input lists into a usable
 *  policy. An empty list falls back to its default — the conservative
 *  direction: a session still has to clear an origin bound to be closed. */
export function resolveOriginPolicy(policy) {
  const p = policy ?? {}
  const list = (value, fallback) => {
    const kept = Array.isArray(value) ? value.filter(isNonEmptyString).map((s) => s.trim()) : []
    return kept.length > 0 ? kept : fallback
  }
  return {
    userOrigins: list(p.userOrigins, DEFAULT_USER_ORIGINS),
    closableOrigins: list(p.closableOrigins, DEFAULT_CLOSABLE_ORIGINS),
  }
}

/** The origin class of a candidate:
 *  - `"user"` — human-launched: a `userOrigins` match, OR a root with no
 *    origin and no parent. FLAG ONLY, never close.
 *  - `"closable"` — a `closableOrigins` match (cron:*, gate) or an executor
 *    (has a `parentSessionId`). Close allowed under the current rules.
 *  `userOrigins` wins over both `closableOrigins` and the executor rule, so a
 *  `vscode` executor is still user-origin. An unrecognized root origin is
 *  treated as `"user"` (conservative). */
export function classifyOrigin(session, policy) {
  const { userOrigins, closableOrigins } = resolveOriginPolicy(policy)
  const origin = session?.origin
  if (isNonEmptyString(origin) && userOrigins.some((o) => matchesOrigin(origin, o))) return "user"
  if (isNonEmptyString(origin) && closableOrigins.some((o) => matchesOrigin(origin, o))) return "closable"
  if (isNonEmptyString(session?.parentSessionId)) return "closable"
  return "user"
}

const CLOSE_VERDICTS = new Set(["done", "abandoned"])
const FLAG_VERDICTS = new Set(["blocked", "needs-input"])

/**
 * The single decision the steward acts on, pure over its arguments:
 * `{ action: "close" | "flag" | "skip", reason }`. `reason` is the label the
 * report shows and states the retained action even in a dry run (with a
 * `(dry run)` marker), so `action` never depends on `apply`; the queue
 * builders separately gate execution on `apply`.
 *
 *  - rule-certain `close`/`stuck` → `close`;
 *  - a judge `done`/`abandoned` at or above `minConfidence` → `close`;
 *  - a judge `blocked`/`needs-input` at or above `minConfidence` → `flag`;
 *  - anything else (`active`, below threshold, unknown verdict/class) → `skip`;
 *  - a user-origin candidate is ALWAYS downgraded to `flag` — even a
 *    rule-certain close or a confident `done` — with {@link USER_ORIGIN_REASON}.
 */
export function decideAction({ session, planClass, verdict, confidence, apply, policy, minConfidence } = {}) {
  const originClass = classifyOrigin(session, policy)
  const dry = apply !== true
  const skipped = (reason) => ({ action: "skip", reason: dry ? `${reason} (dry run)` : reason })

  let action
  let reason
  if (planClass === "close") {
    action = "close"
    reason = "close (règle certaine)"
  } else if (planClass === "stuck") {
    action = "close"
    reason = "close (stuck, jamais démarrée)"
  } else if (planClass === "judge") {
    if (typeof confidence === "number" && typeof minConfidence === "number" && confidence < minConfidence) {
      return skipped(`skip (confiance ${confidence} < ${minConfidence})`)
    }
    if (CLOSE_VERDICTS.has(verdict)) {
      action = "close"
      reason = `close (verdict ${verdict} confiant)`
    } else if (FLAG_VERDICTS.has(verdict)) {
      action = "flag"
      reason = `flag (${verdict})`
    } else {
      return skipped(`skip (verdict ${verdict ?? "inconnu"})`)
    }
  } else {
    return skipped(`skip (classe ${planClass ?? "inconnue"})`)
  }

  if (originClass === "user" && action === "close") {
    action = "flag"
    reason = USER_ORIGIN_REASON
  }
  return { action, reason: dry ? `${reason} (dry run)` : reason }
}
