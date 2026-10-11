/**
 * Turn retry: re-prompt a LIVE session whose last turn failed for a
 * transient provider reason, opt-in via `agent_start.turnRetry`.
 *
 * The gap it closes (observed on free OpenCode Zen models, 2026-10-11): when
 * a provider answers 429/5xx mid-turn, the session just stops — either the
 * harness ends the turn in-band with an error (`lastTurnErrorMessage` set,
 * session idle), or opencode swallows the 429 into a silent internal retry
 * loop and the stall watchdog only marks it (`markStalled` →
 * `NO_OUTPUT_STALL_TURN_ERROR`). `restartPolicy` does not help: the process
 * is alive, nothing crashed.
 *
 * Shape mirrors `restart-scheduler.ts`: pure halves (`classifyTurnError`,
 * `decideTurnRetry`, `computeTurnRetryDelayMs`) plus an event-driven
 * controller (`createTurnRetryController`) that only talks to the registry
 * through a narrow structural slice. The controller:
 *   - on `session:turn-end` with `reason:"error"` → classify the error and,
 *     when eligible, schedule a continuation prompt after backoff;
 *   - on `session:stalled` whose row carries the no-output marker → schedule
 *     an interrupt + continuation prompt after backoff (the stuck turn is
 *     still running, so `enqueuePrompt({interrupt:true})` cuts it first);
 *   - on a clean `session:turn-end` → reset the retry counter;
 *   - on `session:stall-cleared` / `session:exited` / any newer turn-end →
 *     drop a pending retry; `policy:failed` halts retries for the session.
 *
 * A retry reports `sent` only once its continuation prompt has PASSED
 * admission (`enqueuePrompt` rejects a concurrent prompt, a killed session,
 * a failed resume): a rejected admission rolls the booked attempt back — it
 * costs nothing against `maxRetries` — and emits `cancelled` instead, with the
 * same `[turn-retry]` transcript notice every other transition carries.
 *
 * NEVER retries: an interrupted turn (user Stop, `interrupt:true` prompt), a
 * killed / exited / errored session (kill, `maxCostUsd` cost-cap kill — the
 * process-death path belongs to `restartPolicy`), a session with a failed
 * governance policy (the windowed `costBudget` trips one), an auth/billing
 * error (401/402/403), a provider usage cap, or a turn that already made a
 * tool call outside the read-only allowlist (unless `retryAfterToolCalls`).
 *
 * Pending retries are in-memory timers: a daemon restart drops them (and the
 * controller clears any stale `nextTurnRetryAt` at startup). A turn cut by a
 * daemon restart is the continue-interrupted path's job, not this one's.
 */

import type { SessionDescriptor } from "./sessions.js"
import type { SessionEventBus, SessionTurnRetryEvent } from "./session-event-bus.js"
import { isProviderLimitError } from "./session-end-reason.js"
import type { TurnRetryClass, TurnRetryPolicy } from "./turn-retry-policy.js"

/** Must equal `NO_OUTPUT_STALL_TURN_ERROR` in `sessions.ts` — duplicated (and
 *  pinned by a test) so this module needs no runtime import of the registry. */
export const NO_OUTPUT_STALL_MARKER = "no output since prompt — provider retrying?"

/** Transcript provenance of the continuation prompt. */
export const TURN_RETRY_PROMPT_SOURCE = "daemon:turn-retry"

/** Classes a turn error can fall into. The first three are retryable (when
 *  listed in `turnRetry.on`); the rest never are. */
export type TurnErrorClass = TurnRetryClass | "auth" | "usage-limit" | "other"

const MAX_ERROR_ECHO = 300

/** Pull an HTTP status code out of an error string, when it names one in a
 *  recognisable position ("429 status code", "status: 503", "HTTP 502",
 *  `"status":401`, "503 Service Unavailable"). A bare number elsewhere in the
 *  message ("max_tokens 500") is deliberately NOT read as a status. */
export function extractHttpStatus(message: string): number | undefined {
  const patterns = [
    /\b(?:status(?:[ _-]?code)?|http(?:[ _-]?status)?|statuscode)\b["']?\s*[:=]?\s*["']?([1-5]\d\d)\b/i,
    /\b([1-5]\d\d)\s+(?:status\b|unauthorized|forbidden|payment required|too many requests|internal server error|bad gateway|service unavailable|gateway time-?out|overloaded)/i,
    /\b(?:error|code)\s*[:=]?\s*\(?([45]\d\d)\)?(?=[\s:,.)\]]|$)/i,
  ]
  for (const re of patterns) {
    const m = re.exec(message)
    if (m?.[1]) return Number(m[1])
  }
  return undefined
}

const AUTH_RE =
  /\bunauthori[sz]ed\b|\bforbidden\b|\bpayment required\b|\binvalid[ _-]?(?:api[ _-]?key|x-api-key|token|credentials?)\b|\bauthentication (?:failed|error|required)\b|\binsufficient[ _-](?:credits?|balance|quota|funds)\b|\bcredit balance\b|\bpermission[ _-]denied\b/i
const RATE_LIMIT_RE =
  /\brate[ _-]?limit(?:ed|ing)?\b|\btoo many requests\b|\bresource[ _-]exhausted\b|\bthrottl(?:ed|ing)\b/i
const UPSTREAM_5XX_RE =
  /\binternal server error\b|\bbad gateway\b|\bservice unavailable\b|\bgateway time-?out\b|\boverloaded(?:_error)?\b|\bupstream (?:error|connect|request timeout)\b|\bserver_error\b/i

/**
 * Classify a turn's error text. Order matters: the stall marker is exact;
 * a usage cap and auth/billing are checked BEFORE rate-limit because some
 * providers report "insufficient quota" with a 429.
 */
export function classifyTurnError(message: string | undefined): TurnErrorClass {
  if (!message) return "other"
  if (message === NO_OUTPUT_STALL_MARKER) return "no-output-stall"
  if (isProviderLimitError(message)) return "usage-limit"
  const status = extractHttpStatus(message)
  if (status === 401 || status === 402 || status === 403 || AUTH_RE.test(message)) return "auth"
  if (status === 429 || RATE_LIMIT_RE.test(message)) return "rate-limit"
  if ((status !== undefined && status >= 500 && status <= 599) || UPSTREAM_5XX_RE.test(message)) {
    return "upstream-5xx"
  }
  return "other"
}

/** Provider "retry after" hint in ms, when the message carries one
 *  ("retry after 30s", "Retry-After: 12", "try again in 2 minutes"). */
export function extractRetryAfterMs(message: string | undefined): number | undefined {
  if (!message) return undefined
  const m =
    /\b(?:retry[ -]after|try again in|retry in)\b["':\s]*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)?\b/i.exec(
      message,
    )
  if (!m?.[1]) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n) || n < 0) return undefined
  const unit = (m[2] ?? "s").toLowerCase()
  if (unit.startsWith("ms") || unit.startsWith("milli")) return Math.round(n)
  if (unit.startsWith("m")) return Math.round(n * 60_000)
  return Math.round(n * 1_000)
}

/** Backoff for the `attempt`-th retry (0-indexed), raised to the provider's
 *  retry-after hint when one is given, and capped at `maxDelayMs`. */
export function computeTurnRetryDelayMs(
  policy: TurnRetryPolicy,
  attempt: number,
  retryAfterMs?: number,
): number {
  const backoff = policy.baseDelayMs * policy.factor ** attempt
  return Math.min(Math.max(backoff, retryAfterMs ?? 0), policy.maxDelayMs)
}

/** Read-only tool names (first word of the name/title, lowercased): a turn
 *  that only made these calls is safe to continue. Anything else — or an
 *  unnamed call — counts as possibly side-effecting. */
const READ_ONLY_TOOLS = new Set([
  "read",
  "view",
  "cat",
  "glob",
  "grep",
  "ls",
  "list",
  "find",
  "search",
  "fetch",
  "webfetch",
  "websearch",
  "todoread",
  "todowrite",
  "think",
])

export function isReadOnlyToolName(name: string): boolean {
  const head = name.trim().split(/[\s:(_.-]/)[0]?.toLowerCase() ?? ""
  return head !== "" && READ_ONLY_TOOLS.has(head)
}

/** What happened at the end of (or during) the failed turn. */
export type TurnRetryTrigger =
  | {
      kind: "turn-end"
      reason?: string
      error?: string
      interrupted?: boolean
      toolCalls?: readonly string[]
    }
  | { kind: "stall" }

export type TurnRetryDecision =
  | { action: "ignore" }
  | { action: "skip"; errorClass: TurnErrorClass; skipReason: string; error?: string }
  | { action: "exhausted"; errorClass: TurnErrorClass; attempts: number; error?: string }
  | { action: "retry"; errorClass: TurnRetryClass; attempt: number; delayMs: number; error?: string }

function echo(message: string | undefined): string | undefined {
  if (!message) return undefined
  return message.length > MAX_ERROR_ECHO ? `${message.slice(0, MAX_ERROR_ECHO)}…` : message
}

/**
 * Pure retry decision for one trigger on one row. `ignore` = not a failure
 * this module reacts to at all (no event); `skip` = a failure deliberately
 * not retried (one `skipped` event); `exhausted` = retry budget spent.
 */
export function decideTurnRetry(
  desc: SessionDescriptor,
  trigger: TurnRetryTrigger,
  opts: { halted?: boolean } = {},
): TurnRetryDecision {
  const policy = desc.turnRetry
  if (!policy || desc.kind !== "agent-cli") return { action: "ignore" }

  let message: string | undefined
  if (trigger.kind === "stall") {
    // Only the no-output stall is a provider-retry symptom; a stall after
    // real output is a slow tool/turn, not ours to cut.
    if (desc.lastTurnErrorMessage !== NO_OUTPUT_STALL_MARKER) return { action: "ignore" }
    message = NO_OUTPUT_STALL_MARKER
  } else {
    if (trigger.reason !== "error") return { action: "ignore" }
    message = trigger.error ?? desc.lastTurnErrorMessage
  }
  const errorClass = classifyTurnError(message)
  const error = echo(message)
  const skip = (skipReason: string): TurnRetryDecision => ({ action: "skip", errorClass, skipReason, error })

  if (desc.status !== "running") return skip(`session ${desc.status}`)
  if (trigger.kind === "turn-end" && trigger.interrupted) return skip("turn was interrupted")
  if (opts.halted) return skip("a governance policy failed for this session")
  if (errorClass === "auth") return skip("auth/billing error — retrying cannot fix it")
  if (errorClass === "usage-limit") return skip("provider usage cap — resets on its own schedule")
  if (errorClass === "other") return skip("not a transient provider error")
  if (!policy.on.includes(errorClass)) return skip(`class "${errorClass}" not in turnRetry.on`)
  if (trigger.kind === "turn-end" && !policy.retryAfterToolCalls) {
    const unsafe = (trigger.toolCalls ?? []).filter(n => !isReadOnlyToolName(n))
    if (unsafe.length > 0) {
      return skip(
        `turn already made ${unsafe.length} possibly side-effecting tool call(s) ` +
          `(${unsafe.slice(0, 3).map(n => n || "unnamed").join(", ")}) — set retryAfterToolCalls to allow`,
      )
    }
  }
  const attempts = desc.turnRetryAttempts ?? 0
  if (attempts >= policy.maxRetries) return { action: "exhausted", errorClass, attempts, error }
  const retryAfterMs = errorClass === "rate-limit" ? extractRetryAfterMs(message) : undefined
  return {
    action: "retry",
    errorClass,
    attempt: attempts + 1,
    delayMs: computeTurnRetryDelayMs(policy, attempts, retryAfterMs),
    error,
  }
}

/** The continuation prompt sent to the session. */
export function buildContinuationPrompt(error: string | undefined): string {
  return `Continue where you stopped; the previous turn failed with: ${error ?? "an unknown provider error"}`
}

/** Turn-end reasons that are NOT a clean completion — they never reset the
 *  retry counter (our own stall interrupt ends a turn as `cancelled`/
 *  `aborted`, and must not wipe the count it is incrementing). */
const NON_CLEAN_REASONS = new Set(["error", "aborted", "cancelled", "watchdog-timeout"])

/** Registry slice the controller needs — structural, so tests can stub it. */
export interface TurnRetryRegistry {
  get(id: string): SessionDescriptor | undefined
  list(opts?: { includeArchived?: boolean }): readonly SessionDescriptor[]
  enqueuePrompt(
    id: string,
    message: unknown,
    opts?: { interrupt?: boolean; source?: string; origin?: string },
  ): Promise<unknown>
  recordNotice(id: string, text: string): boolean
  patchTurnRetry(
    id: string,
    patch: {
      turnRetryAttempts?: number | null
      lastTurnRetryAt?: string | null
      nextTurnRetryAt?: string | null
    },
  ): boolean
}

interface PendingRetry {
  timer: ReturnType<typeof setTimeout>
  kind: "turn-end" | "stall"
  errorClass: TurnRetryClass
  attempt: number
  error?: string
  /** turn-end guard: the row must still be idle at the same turn count. */
  turnsCompleted?: number
  /** stall guard: the row must still carry this very stall. */
  stalledSinceMs?: number
}

export interface TurnRetryController {
  dispose(): void
  /** Ids with a scheduled-but-unsent retry (for tests/diagnostics). */
  pendingIds(): string[]
}

export function createTurnRetryController(opts: {
  registry: TurnRetryRegistry
  sessionEvents: SessionEventBus
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void
  log?: (line: string) => void
}): TurnRetryController {
  const { registry, sessionEvents } = opts
  const now = opts.now ?? Date.now
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return t
    })
  const clearTimer = opts.clearTimer ?? ((t: ReturnType<typeof setTimeout>) => clearTimeout(t))
  const log = opts.log ?? ((line: string) => console.warn(line))
  const pending = new Map<string, PendingRetry>()
  const halted = new Set<string>()

  // A pending retry never survives a daemon restart — drop stale landing
  // times so no row advertises a retry nobody will send.
  for (const d of registry.list({ includeArchived: true })) {
    if (d.nextTurnRetryAt !== undefined) registry.patchTurnRetry(d.id, { nextTurnRetryAt: null })
  }

  const emit = (
    desc: SessionDescriptor,
    ev: Omit<SessionTurnRetryEvent, "type" | "sessionId" | "label" | "ts" | "maxRetries">,
  ): void => {
    sessionEvents.emit({
      type: "session:turn-retry",
      sessionId: desc.id,
      maxRetries: desc.turnRetry?.maxRetries ?? 0,
      ...ev,
      ...(desc.label ? { label: desc.label } : {}),
      ts: new Date(now()).toISOString(),
    })
  }

  const cancel = (id: string, why: string): void => {
    const p = pending.get(id)
    if (!p) return
    clearTimer(p.timer)
    pending.delete(id)
    registry.patchTurnRetry(id, { nextTurnRetryAt: null })
    const desc = registry.get(id)
    if (desc) {
      emit(desc, { phase: "cancelled", errorClass: p.errorClass, attempt: p.attempt, skipReason: why })
      registry.recordNotice(id, `[turn-retry] cancelled retry ${p.attempt}: ${why}`)
    }
  }

  const fire = (id: string, p: PendingRetry): void => {
    if (pending.get(id) !== p) return
    pending.delete(id)
    registry.patchTurnRetry(id, { nextTurnRetryAt: null })
    const desc = registry.get(id)
    if (!desc) return
    const stale =
      desc.status !== "running"
        ? `session ${desc.status}`
        : p.kind === "turn-end"
          ? desc.busy === true || (desc.turnsCompleted ?? 0) !== p.turnsCompleted
            ? "the session moved on (new turn) before the retry landed"
            : undefined
          : desc.stalledSinceMs !== p.stalledSinceMs || desc.busy !== true
            ? "the stalled turn recovered or ended before the retry landed"
            : undefined
    if (stale) {
      emit(desc, { phase: "cancelled", errorClass: p.errorClass, attempt: p.attempt, skipReason: stale })
      registry.recordNotice(id, `[turn-retry] cancelled retry ${p.attempt}: ${stale}`)
      return
    }
    const nowIso = new Date(now()).toISOString()
    const prevAttempts = desc.turnRetryAttempts
    const prevLastTurnRetryAt = desc.lastTurnRetryAt
    // Book the attempt BEFORE sending: a continuation turn that itself fails
    // still counts toward `maxRetries` — its turn-end can land before the
    // admission promise below settles, and the counter must already be spent.
    registry.patchTurnRetry(id, { turnRetryAttempts: p.attempt, lastTurnRetryAt: nowIso })
    registry
      .enqueuePrompt(id, buildContinuationPrompt(p.error), {
        source: TURN_RETRY_PROMPT_SOURCE,
        origin: "daemon",
        ...(p.kind === "stall" ? { interrupt: true } : {}),
      })
      .then(
        () => {
          // Admission succeeded — only NOW is the retry actually "sent" (and
          // only now does the attempt it booked stick).
          emit(desc, {
            phase: "sent",
            errorClass: p.errorClass,
            attempt: p.attempt,
            ...(p.error ? { error: p.error } : {}),
          })
          registry.recordNotice(
            id,
            `[turn-retry] retry ${p.attempt}/${desc.turnRetry?.maxRetries ?? "?"} (${p.errorClass}) — sending continuation prompt`,
          )
        },
        err => {
          // Admission REJECTED (concurrent prompt, kill, failed resume): the
          // retry never happened — roll the booking back so it costs nothing
          // against `maxRetries`, and report it as a cancellation, never `sent`.
          const msg = err instanceof Error ? err.message : String(err)
          log(`[turn-retry] ${id}: continuation prompt rejected: ${msg}`)
          registry.patchTurnRetry(id, {
            turnRetryAttempts: prevAttempts ?? null,
            lastTurnRetryAt: prevLastTurnRetryAt ?? null,
          })
          registry.recordNotice(id, `[turn-retry] cancelled retry ${p.attempt}: continuation prompt rejected: ${msg}`)
          const fresh = registry.get(id) ?? desc
          emit(fresh, {
            phase: "cancelled",
            errorClass: p.errorClass,
            attempt: p.attempt,
            skipReason: `continuation prompt rejected: ${msg}`,
            ...(p.error ? { error: p.error } : {}),
          })
        },
      )
  }

  const handle = (id: string, trigger: Parameters<typeof decideTurnRetry>[1]): void => {
    const desc = registry.get(id)
    if (!desc?.turnRetry) return
    const decision = decideTurnRetry(desc, trigger, { halted: halted.has(id) })
    switch (decision.action) {
      case "ignore":
        return
      case "skip":
        emit(desc, {
          phase: "skipped",
          errorClass: decision.errorClass,
          attempt: desc.turnRetryAttempts ?? 0,
          skipReason: decision.skipReason,
          ...(decision.error ? { error: decision.error } : {}),
        })
        registry.recordNotice(id, `[turn-retry] not retrying: ${decision.skipReason}`)
        return
      case "exhausted":
        emit(desc, {
          phase: "exhausted",
          errorClass: decision.errorClass,
          attempt: decision.attempts,
          ...(decision.error ? { error: decision.error } : {}),
        })
        registry.recordNotice(
          id,
          `[turn-retry] gave up after ${decision.attempts} consecutive retries (${decision.errorClass}) — leaving the session idle`,
        )
        return
      case "retry": {
        const p: PendingRetry = {
          kind: trigger.kind,
          errorClass: decision.errorClass,
          attempt: decision.attempt,
          ...(decision.error ? { error: decision.error } : {}),
          ...(trigger.kind === "turn-end"
            ? { turnsCompleted: desc.turnsCompleted ?? 0 }
            : { stalledSinceMs: desc.stalledSinceMs }),
          timer: undefined as unknown as ReturnType<typeof setTimeout>,
        }
        p.timer = setTimer(() => fire(id, p), decision.delayMs)
        pending.set(id, p)
        registry.patchTurnRetry(id, { nextTurnRetryAt: new Date(now() + decision.delayMs).toISOString() })
        emit(desc, {
          phase: "scheduled",
          errorClass: decision.errorClass,
          attempt: decision.attempt,
          delayMs: decision.delayMs,
          ...(decision.error ? { error: decision.error } : {}),
        })
        registry.recordNotice(
          id,
          `[turn-retry] ${decision.errorClass}: retry ${decision.attempt}/${desc.turnRetry.maxRetries} in ${Math.round(decision.delayMs / 1000)}s`,
        )
        return
      }
    }
  }

  const unsubs = [
    sessionEvents.on("session:turn-end", ev => {
      const desc = registry.get(ev.sessionId)
      if (!desc?.turnRetry) return
      // Any turn-end supersedes a pending retry for this row (a stall that
      // finally errored on its own, a user prompt that ran meanwhile).
      cancel(ev.sessionId, "a newer turn ended first")
      if (ev.reason === "error") {
        handle(ev.sessionId, {
          kind: "turn-end",
          reason: ev.reason,
          ...(ev.error !== undefined ? { error: ev.error } : {}),
          ...(ev.interrupted ? { interrupted: true } : {}),
          ...(ev.toolCalls ? { toolCalls: ev.toolCalls } : {}),
        })
        return
      }
      const clean = !ev.interrupted && !NON_CLEAN_REASONS.has(ev.reason ?? "") && ev.error === undefined
      if (clean && (desc.turnRetryAttempts !== undefined || desc.lastTurnRetryAt !== undefined)) {
        registry.patchTurnRetry(ev.sessionId, { turnRetryAttempts: null, lastTurnRetryAt: null })
      }
    }),
    sessionEvents.on("session:stalled", ev => {
      if (pending.has(ev.sessionId)) return
      handle(ev.sessionId, { kind: "stall" })
    }),
    sessionEvents.on("session:stall-cleared", ev => {
      if (pending.get(ev.sessionId)?.kind === "stall") cancel(ev.sessionId, "the stalled turn produced output again")
    }),
    sessionEvents.on("session:exited", ev => {
      cancel(ev.sessionId, "session exited")
    }),
    sessionEvents.on("policy:failed", ev => {
      const desc = registry.get(ev.sessionId)
      if (!desc?.turnRetry) return
      halted.add(ev.sessionId)
      cancel(ev.sessionId, "a governance policy failed for this session")
    }),
  ]

  return {
    dispose() {
      for (const u of unsubs) u()
      for (const p of pending.values()) clearTimer(p.timer)
      pending.clear()
    },
    pendingIds: () => [...pending.keys()],
  }
}
