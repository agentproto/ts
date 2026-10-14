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
 * Rotation (`turnRetry.rotate`): instead of re-prompting the model that was
 * just throttled, the controller first switches the live session to the next
 * fallback target (`registry.setModel` — the `agent_set_model` path), then
 * sends the continuation. A rate-limited / silently-stalled model is recorded
 * in a DAEMON-WIDE cooldown map (the free-tier limit is per model per IP, so
 * it binds every session), and rotation skips cooling models. A free session
 * only ever rotates onto free ids. With no eligible target the retry falls
 * back to today's same-model behaviour and says so in the `[turn-retry]`
 * notice. v1 switches the model on the session's current profile only.
 *
 * Migration (`turnRetry.action: "migrate"`): a matching failure on a SANDBOX
 * session moves the session to a fresh box — a new IP, the same workspace
 * branch, the transcript carried over — via the injected `migrateSession`
 * orchestration (PR 2's `session_migrate`, called in-process, not over MCP),
 * then re-prompts "continue" on the migrated session. A non-sandbox session
 * and a spent `maxMigrations` cap both fall back to a normal retry, with a
 * `[turn-retry]` notice explaining why; a migration that fails leaves the old
 * session untouched and falls back to a normal retry as well.
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
import type { MigrateSandboxSessionResult } from "./session-migrate.js"
import { isProviderLimitError } from "./session-end-reason.js"
import { createModelCooldowns, type ModelCooldowns } from "./model-cooldowns.js"
import {
  isOpencodeFreeModel,
  TURN_ROTATE_DEFAULTS,
  type TurnRetryClass,
  type TurnRetryPolicy,
  type TurnRetryRotateTarget,
} from "./turn-retry-policy.js"

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
  /\binternal server error\b|\bbad gateway\b|\bservice unavailable\b|\bgateway time-?out\b|\boverloaded(?:_error)?\b|\bupstream (?:error|connect|request timeout)\b|\bserver_error\b|\bendpoint (?:is )?(?:currently )?unavailable\b/i

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

/** Does this row run in a sandbox box (rather than as a local subprocess)?
 *  A `device:` box also says `remote`, but the deep pre-flight (work branch,
 *  workspace remote, checkpoint) is `assessMigration`'s job — this is only
 *  the "CAN it be a box migration at all" gate, matching the class of
 *  session `turnRetry.action: "migrate"` is written for. */
export function isSandboxSession(desc: Pick<SessionDescriptor, "kind" | "remote">): boolean {
  return desc.kind === "agent-cli" && desc.remote === true
}

/** The parts of a `turnRetry` rule that steer the action decision. */
export type TurnRetryActionRule = Pick<TurnRetryPolicy, "action" | "maxRetries" | "maxMigrations">

/** What a retry-eligible failure becomes once the action is applied. */
export type TurnRetryActionDecision =
  /** Re-prompt the same live session after backoff (the default action, or a
   *  migrate-action fallback — `note` then explains the downgrade). */
  | { action: "retry"; errorClass: TurnRetryClass; attempt: number; delayMs: number; error?: string; note?: string }
  /** Move the sandbox session to a fresh box and re-prompt it there. */
  | { action: "migrate"; errorClass: TurnRetryClass; attempt: number; error?: string }
  /** Stop: no migration left AND no retry budget left. */
  | { action: "give-up"; errorClass: TurnRetryClass; attempts: number; error?: string }

/**
 * Pure decision for a retry-ELIGIBLE failure (one `decideTurnRetry` already
 * returned `retry` — every never-retry rule lives there) once the policy's
 * `action` is applied:
 *
 *  - `action: "retry"` (the default) passes `base` through unchanged — an
 *    existing policy behaves exactly as before;
 *  - `action: "migrate"` on a SANDBOX session under the `maxMigrations` cap
 *    migrates (`attempt` is the 1-based migration number);
 *  - `action: "migrate"` on a non-sandbox session, or once the cap is spent,
 *    falls back to the normal retry/give-up path — `retry` while
 *    `counters.attempts` is inside `maxRetries` (with a `note` the wiring
 *    stamps into the transcript), `give-up` once it is spent.
 */
export function decideTurnRetryAction(
  base: Extract<TurnRetryDecision, { action: "retry" }>,
  rule: TurnRetryActionRule,
  sessionKind: Pick<SessionDescriptor, "kind" | "remote">,
  counters: { attempts: number; migrations: number },
): TurnRetryActionDecision {
  if (rule.action !== "migrate") return base
  if (!isSandboxSession(sessionKind)) {
    return {
      ...base,
      note:
        'turnRetry action "migrate" needs a sandbox session — this session runs on the host, ' +
        "so it is retried where it is",
    }
  }
  if (counters.migrations >= rule.maxMigrations) {
    if (counters.attempts >= rule.maxRetries) {
      return { action: "give-up", errorClass: base.errorClass, attempts: counters.attempts, error: base.error }
    }
    return {
      ...base,
      note:
        `migration cap reached (${counters.migrations}/${rule.maxMigrations}) — ` +
        "retrying on the current box",
    }
  }
  return { action: "migrate", errorClass: base.errorClass, attempt: counters.migrations + 1, error: base.error }
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
      turnMigrations?: number | null
      lastTurnRetryAt?: string | null
      nextTurnRetryAt?: string | null
    },
  ): boolean
  /** Live model switch (`agent_set_model`). Absent ⇒ rotation is unavailable. */
  setModel?(id: string, modelId: string): Promise<{ applied: boolean; reason?: string }>
  /** Cut the in-flight turn before a switch on a stalled session. */
  interruptSession?(id: string): Promise<unknown>
}

/** Async eligibility verdict for a rotation target: `undefined` = eligible,
 *  otherwise a short reason it is not. Runs the same checks a spawn would
 *  (adapter/route match, the profile's model allow-list). */
export type RotationTargetCheck = (
  desc: SessionDescriptor,
  target: TurnRetryRotateTarget,
) => Promise<string | undefined>

/** Pure part of rotation eligibility: same model, daemon-wide cooldown, free
 *  stays free, and the v1 same-profile limit. `undefined` = passes. */
export function rotationTargetRejection(
  desc: SessionDescriptor,
  target: TurnRetryRotateTarget,
  cooldowns: ModelCooldowns,
  now: number,
): string | undefined {
  if (target.model === desc.model) return "already the current model"
  const until = cooldowns.until(target.model)
  if (until !== undefined) return `cooling down for ${Math.max(1, Math.round((until - now) / 1000))}s more`
  if (desc.model && isOpencodeFreeModel(desc.model) && !isOpencodeFreeModel(target.model)) {
    return "paid model — a free session never rotates onto a paid id"
  }
  const current = desc.accessProfile?.profileRef
  if (target.profileRef !== undefined && target.profileRef !== current) {
    return `needs profile "${target.profileRef}" (session runs ${current ? `"${current}"` : "the host default"}) — profile switching is not supported live`
  }
  return undefined
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
  /** `migrate` (box migration, `turnRetry.action`) instead of an in-place
   *  retry. `attempt` then counts migrations, booked against
   *  `turnMigrations` rather than `turnRetryAttempts`. */
  mode?: "retry" | "migrate"
}

export interface TurnRetryController {
  dispose(): void
  /** Ids with a scheduled-but-unsent retry (for tests/diagnostics). */
  pendingIds(): string[]
}

/** Move a sandbox session onto a fresh box — the in-process arm of PR 2's
 *  `session_migrate` orchestration (`migrateSandboxSession`), injected here
 *  so the controller keeps only a narrow structural dependency. Throws on a
 *  session that cannot be migrated (the old session is then left untouched). */
export type MigrateSessionFn = (prev: SessionDescriptor) => Promise<MigrateSandboxSessionResult>

export function createTurnRetryController(opts: {
  registry: TurnRetryRegistry
  sessionEvents: SessionEventBus
  now?: () => number
  /** Daemon-wide model cooldowns. Defaults to a private map (tests/standalone). */
  cooldowns?: ModelCooldowns
  /** Extra async eligibility gate for rotation targets (adapter/route + profile allow-list). */
  checkRotationTarget?: RotationTargetCheck
  /** Box-migration orchestration for `turnRetry.action: "migrate"`. Absent ⇒ a
   *  migration decision falls back to a normal retry with a notice. */
  migrateSession?: MigrateSessionFn
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void
  log?: (line: string) => void
}): TurnRetryController {
  const { registry, sessionEvents } = opts
  const now = opts.now ?? Date.now
  const cooldowns = opts.cooldowns ?? createModelCooldowns(now)
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
    ev: Omit<
      SessionTurnRetryEvent,
      "type" | "sessionId" | "label" | "ts" | "maxRetries" | "maxMigrations"
    >,
  ): void => {
    sessionEvents.emit({
      type: "session:turn-retry",
      sessionId: desc.id,
      maxRetries: desc.turnRetry?.maxRetries ?? 0,
      maxMigrations: desc.turnRetry?.maxMigrations ?? 0,
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
      registry.recordNotice(
        id,
        p.mode === "migrate"
          ? `[turn-retry] cancelled migration ${p.attempt}: ${why}`
          : `[turn-retry] cancelled retry ${p.attempt}: ${why}`,
      )
    }
  }

  /** Switch the session to the first eligible `turnRetry.rotate` target, if
   *  the policy rotates for this class. Never throws: any failure to rotate
   *  leaves the model unchanged and the retry proceeds on the same model. */
  const rotateIfConfigured = async (desc: SessionDescriptor, p: PendingRetry): Promise<void> => {
    const policy = desc.turnRetry
    if (!policy?.rotate?.length) return
    if (!(policy.rotateOn ?? TURN_ROTATE_DEFAULTS.rotateOn).includes(p.errorClass)) return
    const id = desc.id
    const from = desc.model
    const same = (why: string): void => {
      registry.recordNotice(
        id,
        `[turn-retry] no rotation target available (${why}) — retrying ${from ?? "the same model"} after backoff`,
      )
    }
    if (!registry.setModel) return same("this registry cannot switch models")
    const rejected: string[] = []
    let interrupted = false
    for (const target of policy.rotate) {
      const why =
        rotationTargetRejection(desc, target, cooldowns, now()) ?? (await opts.checkRotationTarget?.(desc, target))
      if (why) {
        rejected.push(`${target.model}: ${why}`)
        continue
      }
      try {
        // A stalled turn is still running — cut it before changing the model.
        if (p.kind === "stall" && !interrupted) {
          interrupted = true
          await registry.interruptSession?.(id)
        }
        const res = await registry.setModel(id, target.model)
        if (!res.applied) {
          rejected.push(`${target.model}: switch not applied${res.reason ? ` (${res.reason})` : ""}`)
          continue
        }
      } catch (err) {
        rejected.push(`${target.model}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      emit(registry.get(id) ?? desc, {
        phase: "rotated",
        errorClass: p.errorClass,
        attempt: p.attempt,
        ...(from ? { fromModel: from } : {}),
        toModel: target.model,
        ...(p.error ? { error: p.error } : {}),
      })
      registry.recordNotice(
        id,
        `[turn-retry] rotating model ${from ?? "?"} → ${target.model} (${p.errorClass})` +
          (rejected.length ? `; skipped ${rejected.join("; ")}` : ""),
      )
      return
    }
    same(rejected.join("; ") || "none listed")
  }

  /**
   * Send the continuation prompt and record the outcome. The attempt must
   * already be booked by the caller; `rollback` undoes that booking when
   * admission is rejected, `extra` annotates the transcript notice (used when
   * a migration fell back to retrying on the current box).
   */
  const sendContinuation = (
    id: string,
    desc: SessionDescriptor,
    p: PendingRetry,
    attempt: number,
    opts: { rollback: () => void; extra?: string },
  ): void => {
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
          const fresh = registry.get(id) ?? desc
          emit(fresh, {
            phase: "sent",
            errorClass: p.errorClass,
            attempt,
            ...(p.error ? { error: p.error } : {}),
          })
          registry.recordNotice(
            id,
            `[turn-retry] retry ${attempt}/${fresh.turnRetry?.maxRetries ?? "?"} (${p.errorClass}) — sending continuation prompt` +
              (opts.extra ? ` (${opts.extra})` : ""),
          )
        },
        err => {
          // Admission REJECTED (concurrent prompt, kill, failed resume): the
          // retry never happened — roll the booking back so it costs nothing
          // against `maxRetries`, and report it as a cancellation, never `sent`.
          const msg = err instanceof Error ? err.message : String(err)
          log(`[turn-retry] ${id}: continuation prompt rejected: ${msg}`)
          opts.rollback()
          registry.recordNotice(id, `[turn-retry] cancelled retry ${attempt}: continuation prompt rejected: ${msg}`)
          const fresh = registry.get(id) ?? desc
          emit(fresh, {
            phase: "cancelled",
            errorClass: p.errorClass,
            attempt,
            skipReason: `continuation prompt rejected: ${msg}`,
            ...(p.error ? { error: p.error } : {}),
          })
        },
      )
  }

  /**
   * `turnRetry.action: "migrate"` — move the sandbox session to a fresh box
   * (new IP) through the injected orchestration, then re-prompt "continue" on
   * the MIGRATED session. Any failure (no orchestrator wired, a session that
   * cannot be migrated, a refused spawn) leaves the old session untouched and
   * falls back to a normal retry on the current box, so a migrate rule can
   * never strand a session: the migration is booked either way (a spent
   * attempt still counts against the cap, so a broken migration path cannot
   * loop), and the fallback books a normal retry attempt.
   */
  const fireMigration = async (
    id: string,
    p: PendingRetry,
    desc: SessionDescriptor,
    nowIso: string,
  ): Promise<void> => {
    const cap = desc.turnRetry?.maxMigrations ?? 0
    const prevAttempts = desc.turnRetryAttempts
    const prevLastTurnRetryAt = desc.lastTurnRetryAt
    const fallbackToRetry = (why: string): void => {
      emit(desc, {
        phase: "migrate-failed",
        errorClass: p.errorClass,
        attempt: p.attempt,
        skipReason: why,
        ...(p.error ? { error: p.error } : {}),
      })
      registry.recordNotice(id, `[turn-retry] did not migrate ${p.attempt}/${cap} (${why}) — retrying on the current box`)
      const attempt = (prevAttempts ?? 0) + 1
      registry.patchTurnRetry(id, { turnRetryAttempts: attempt, lastTurnRetryAt: nowIso })
      sendContinuation(id, desc, p, attempt, {
        rollback: () =>
          registry.patchTurnRetry(id, {
            turnRetryAttempts: prevAttempts ?? null,
            lastTurnRetryAt: prevLastTurnRetryAt ?? null,
          }),
        extra: "after a migration that did not run",
      })
    }

    const migrate = opts.migrateSession
    if (!migrate) return fallbackToRetry("no migration orchestrator is configured")

    // Book the migration BEFORE it runs: a sandbox boot takes a while, and the
    // counter must be spent whether the migration lands or fails.
    registry.patchTurnRetry(id, { turnMigrations: p.attempt, lastTurnRetryAt: nowIso })
    let fresh: MigrateSandboxSessionResult
    try {
      fresh = await migrate(desc)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`[turn-retry] ${id}: migration failed: ${msg}`)
      return fallbackToRetry(`migration failed: ${msg}`)
    }

    const migratedTo = fresh.descriptor.id
    emit(desc, {
      phase: "migrated",
      errorClass: p.errorClass,
      attempt: p.attempt,
      migratedTo,
      ...(p.error ? { error: p.error } : {}),
    })
    registry.recordNotice(
      id,
      `[turn-retry] migrated ${p.attempt}/${cap} (${p.errorClass}) — the session moved to ${migratedTo}; sending continuation prompt`,
    )
    try {
      await registry.enqueuePrompt(migratedTo, buildContinuationPrompt(p.error), {
        source: TURN_RETRY_PROMPT_SOURCE,
        origin: "daemon",
      })
      registry.recordNotice(
        migratedTo,
        `[turn-retry] this session continues ${id} after a box migration (${p.errorClass})`,
      )
    } catch (err) {
      // The new box is up; if it refuses the continuation prompt the session
      // still lives there (the old one is gone), so this is a log + notice.
      const msg = err instanceof Error ? err.message : String(err)
      log(`[turn-retry] ${id}: continuation prompt on the migrated session ${migratedTo} rejected: ${msg}`)
      registry.recordNotice(migratedTo, `[turn-retry] continuation prompt rejected: ${msg}`)
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
      registry.recordNotice(
        id,
        p.mode === "migrate"
          ? `[turn-retry] cancelled migration ${p.attempt}: ${stale}`
          : `[turn-retry] cancelled retry ${p.attempt}: ${stale}`,
      )
      return
    }
    const nowIso = new Date(now()).toISOString()
    if (p.mode === "migrate") {
      void fireMigration(id, p, desc, nowIso)
      return
    }
    const prevAttempts = desc.turnRetryAttempts
    const prevLastTurnRetryAt = desc.lastTurnRetryAt
    // Book the attempt BEFORE sending: a continuation turn that itself fails
    // still counts toward `maxRetries` — its turn-end can land before the
    // admission promise below settles, and the counter must already be spent.
    registry.patchTurnRetry(id, { turnRetryAttempts: p.attempt, lastTurnRetryAt: nowIso })
    rotateIfConfigured(desc, p)
      .catch(err => log(`[turn-retry] ${id}: rotation failed: ${err instanceof Error ? err.message : String(err)}`))
      .then(() =>
        sendContinuation(id, desc, p, p.attempt, {
          rollback: () =>
            registry.patchTurnRetry(id, {
              turnRetryAttempts: prevAttempts ?? null,
              lastTurnRetryAt: prevLastTurnRetryAt ?? null,
            }),
        }),
      )
  }

  /** Record a rate-limit / silent-stall against the model in the daemon-wide
   *  cooldown map, so rotation (in every session) skips it for a while. */
  const noteThrottle = (desc: SessionDescriptor, trigger: TurnRetryTrigger, errorClass: TurnErrorClass): void => {
    if (errorClass !== "rate-limit" && errorClass !== "no-output-stall") return
    if (trigger.kind === "turn-end" && trigger.interrupted) return
    if (!desc.model) return
    const message = trigger.kind === "stall" ? NO_OUTPUT_STALL_MARKER : (trigger.error ?? desc.lastTurnErrorMessage)
    const hint = errorClass === "rate-limit" ? extractRetryAfterMs(message) : undefined
    cooldowns.mark(desc.model, {
      durationMs: hint !== undefined && hint > 0 ? hint : (desc.turnRetry?.cooldownMs ?? TURN_ROTATE_DEFAULTS.cooldownMs),
      reason: errorClass,
      sessionId: desc.id,
    })
  }

  const handle = (id: string, trigger: TurnRetryTrigger): void => {
    const desc = registry.get(id)
    if (!desc?.turnRetry) return
    const decision = decideTurnRetry(desc, trigger, { halted: halted.has(id) })
    if (decision.action !== "ignore") noteThrottle(desc, trigger, decision.errorClass)
    // `turnRetry.action: "migrate"` composes on top of the plain decision: a
    // retry-eligible failure on a sandbox session migrates the session to a
    // fresh box instead, and every other case falls back to the normal path.
    const plan =
      decision.action === "retry"
        ? decideTurnRetryAction(decision, desc.turnRetry, desc, {
            attempts: desc.turnRetryAttempts ?? 0,
            migrations: desc.turnMigrations ?? 0,
          })
        : decision
    // The base backoff stays the schedule for a migration too (the action
    // decision deliberately carries no delay of its own).
    const baseDelayMs = decision.action === "retry" ? decision.delayMs : 0
    switch (plan.action) {
      case "ignore":
        return
      case "skip":
        emit(desc, {
          phase: "skipped",
          errorClass: plan.errorClass,
          attempt: desc.turnRetryAttempts ?? 0,
          skipReason: plan.skipReason,
          ...(plan.error ? { error: plan.error } : {}),
        })
        registry.recordNotice(id, `[turn-retry] not retrying: ${plan.skipReason}`)
        return
      case "exhausted":
      case "give-up":
        emit(desc, {
          phase: "exhausted",
          errorClass: plan.errorClass,
          attempt: plan.attempts,
          ...(plan.error ? { error: plan.error } : {}),
        })
        registry.recordNotice(
          id,
          `[turn-retry] gave up after ${plan.attempts} consecutive retries (${plan.errorClass}) — leaving the session idle`,
        )
        return
      case "retry": {
        if (plan.note) registry.recordNotice(id, `[turn-retry] no migration: ${plan.note}`)
        const p: PendingRetry = {
          kind: trigger.kind,
          errorClass: plan.errorClass,
          attempt: plan.attempt,
          ...(plan.error ? { error: plan.error } : {}),
          ...(trigger.kind === "turn-end"
            ? { turnsCompleted: desc.turnsCompleted ?? 0 }
            : { stalledSinceMs: desc.stalledSinceMs }),
          timer: undefined as unknown as ReturnType<typeof setTimeout>,
        }
        p.timer = setTimer(() => fire(id, p), plan.delayMs)
        pending.set(id, p)
        registry.patchTurnRetry(id, { nextTurnRetryAt: new Date(now() + plan.delayMs).toISOString() })
        emit(desc, {
          phase: "scheduled",
          errorClass: plan.errorClass,
          attempt: plan.attempt,
          delayMs: plan.delayMs,
          ...(plan.error ? { error: plan.error } : {}),
        })
        registry.recordNotice(
          id,
          `[turn-retry] ${plan.errorClass}: retry ${plan.attempt}/${desc.turnRetry.maxRetries} in ${Math.round(plan.delayMs / 1000)}s`,
        )
        return
      }
      case "migrate": {
        // The delay comes from the base decision (the pure action decision
        // carries only the migration number); the counter booked is
        // `turnMigrations`, not `turnRetryAttempts`.
        const p: PendingRetry = {
          kind: trigger.kind,
          errorClass: plan.errorClass,
          attempt: plan.attempt,
          mode: "migrate",
          ...(plan.error ? { error: plan.error } : {}),
          ...(trigger.kind === "turn-end"
            ? { turnsCompleted: desc.turnsCompleted ?? 0 }
            : { stalledSinceMs: desc.stalledSinceMs }),
          timer: undefined as unknown as ReturnType<typeof setTimeout>,
        }
        p.timer = setTimer(() => fire(id, p), baseDelayMs)
        pending.set(id, p)
        registry.patchTurnRetry(id, { nextTurnRetryAt: new Date(now() + baseDelayMs).toISOString() })
        emit(desc, {
          phase: "scheduled",
          errorClass: plan.errorClass,
          attempt: plan.attempt,
          delayMs: baseDelayMs,
          ...(plan.error ? { error: plan.error } : {}),
        })
        registry.recordNotice(
          id,
          `[turn-retry] ${plan.errorClass}: migrate ${plan.attempt}/${desc.turnRetry.maxMigrations} to a fresh box in ${Math.round(baseDelayMs / 1000)}s`,
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
      if (
        clean &&
        (desc.turnRetryAttempts !== undefined ||
          desc.lastTurnRetryAt !== undefined ||
          desc.turnMigrations !== undefined)
      ) {
        registry.patchTurnRetry(ev.sessionId, { turnRetryAttempts: null, turnMigrations: null, lastTurnRetryAt: null })
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
