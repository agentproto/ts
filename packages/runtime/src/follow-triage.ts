/**
 * follow-triage — deterministic, LLM-free triage of session-follow events,
 * run BEFORE a digest is allowed to wake the follower.
 *
 * The problem: an orchestrator that follows many sessions is woken dozens of
 * times an hour, and most digests ask for nothing. The fix is not a better
 * prompt but a pre-wake filter: every event that would enter a digest is
 * classified `wake` | `fyi` | `drop` by rules the operator can see, toggle,
 * and audit.
 *
 * DESIGN
 * - Disabled by default. A follow without `triage.enabled` behaves EXACTLY
 *   as before (no triage, no JSONL, same digests).
 * - Each rule is a separate switch. The rules are checked in a fixed order;
 *   the first match wins and names itself in the decision record.
 * - `wake`/`fyi`/`drop` are about ATTENTION, not truth: `drop` events are
 *   still written to the JSONL ledger (training data for a future
 *   classifier), they are just not shown.
 * - The `classifier` hook is the extension point for a future LLM
 *   classifier (Jev): it receives the event as JSON and answers
 *   `wake`/`fyi`/`drop`. On timeout, error, or an unparsable answer the
 *   engine FALLS BACK to the deterministic rules — a classifier can never
 *   silence the pipeline, only refine it. The always-wake events
 *   (awaiting-input, crashed, a turn-end with a question) are never
 *   overridable.
 *
 * The module is pure: it takes an event, the resolved config, and a small
 * set of FACTS the engine knows (did this session just report up? is it a
 * live session of the follower? did a new turn start? did its cron run
 * finish OK?) and returns a decision. No I/O except the classifier call and
 * the optional JSONL ledger, both injected by the caller.
 */

import { spawn } from "node:child_process"

import type { FollowEvent } from "./session-follow-store.js"

// ── Decisions ─────────────────────────────────────────────────────────

export const FOLLOW_TRIAGE_DECISIONS = ["wake", "fyi", "drop"] as const
export type TriageDecision = (typeof FOLLOW_TRIAGE_DECISIONS)[number]

export function isTriageDecision(value: unknown): value is TriageDecision {
  return typeof value === "string" && (FOLLOW_TRIAGE_DECISIONS as readonly string[]).includes(value)
}

// ── Config ────────────────────────────────────────────────────────────

/**
 * The per-rule switches. Every rule is independently activatable; a rule
 * that is off simply never fires (the event then falls through to the next
 * rule, and finally to the default `wake`).
 */
export interface FollowTriageRules {
  /** `task-changed` whose ACTOR is the follower itself → `drop`. The
   *  follower's own board writes are its own business. */
  ownTaskChanges: boolean
  /** `exited` with reason `operator-stopped` / `operator-completed` (the
   *  follower or the operator asked for the stop) → `fyi`. Nobody is
   *  waiting on a session that was deliberately stopped. */
  operatorExit: boolean
  /** `exited` for a session whose cron run finished OK → `drop`. The cron
   *  run already reported its own success. */
  cronOk: boolean
  /** `turn-end` from a session that reported UP to the follower in the
   *  last `reportWindowMs` → `drop`: the report already arrived, the
   *  turn-end is the echo. */
  reportedTurnEnd: boolean
  /** an empty or `cancelled` turn-end that was FOLLOWED BY A NEW TURN →
   *  `fyi`: the session moved on, the stale turn-end is noise. */
  emptyTurnEnd: boolean
  /** `pr-opened` / `pr-merged` authored by another LIVE session of the
   *  follower → `fyi`: the follower will hear about its own PR from the
   *  session that opened it. */
  ownPr: boolean
}

export const DEFAULT_FOLLOW_TRIAGE_RULES: FollowTriageRules = {
  ownTaskChanges: true,
  operatorExit: true,
  cronOk: true,
  reportedTurnEnd: true,
  emptyTurnEnd: true,
  ownPr: true,
}

/** How long after a `message_parent` report a turn-end is considered its
 *  echo. Default 60s. */
export const DEFAULT_FOLLOW_TRIAGE_REPORT_WINDOW_MS = 60_000

/** Default timeout for one classifier call. */
export const DEFAULT_FOLLOW_TRIAGE_CLASSIFIER_TIMEOUT_MS = 5_000

/**
 * The classifier extension point. `command` is a shell command that receives
 * the event as JSON on stdin and answers `wake`/`fyi`/`drop` on stdout;
 * `url` is an HTTP endpoint that receives the same JSON and answers
 * `{"decision":"wake"}` (a bare `wake`/`fyi`/`drop` body is accepted too).
 */
export interface FollowTriageClassifier {
  command?: string
  url?: string
  timeoutMs?: number
}

/** The resolved triage configuration. */
export interface FollowTriageConfig {
  enabled: boolean
  rules: FollowTriageRules
  classifier?: FollowTriageClassifier
  reportWindowMs: number
}

/** The (partial) triage block as stored on a follow / in the daemon config.
 *  Everything is optional: an unset field falls back to the daemon default. */
export interface FollowTriageInput {
  enabled?: boolean
  rules?: Partial<FollowTriageRules>
  classifier?: FollowTriageClassifier
  reportWindowMs?: number
}

/** The triage block a single FOLLOW may carry. Deliberately has no
 *  `classifier`: the hook runs a shell command / HTTP request on the host,
 *  so it is only configurable in the operator-owned daemon config. */
export type FollowTriageFollowInput = Omit<FollowTriageInput, "classifier">

/** Resolve a partial triage block against the daemon-level default. */
export function resolveFollowTriageConfig(
  base?: FollowTriageConfig,
  override?: FollowTriageInput | FollowTriageFollowInput,
): FollowTriageConfig {
  const baseRules = base?.rules ?? DEFAULT_FOLLOW_TRIAGE_RULES
  const overrideClassifier = (override as FollowTriageInput | undefined)?.classifier
  return {
    enabled: override?.enabled ?? base?.enabled ?? false,
    rules: { ...baseRules, ...(override?.rules ?? {}) },
    ...(overrideClassifier ?? base?.classifier ? { classifier: overrideClassifier ?? base?.classifier } : {}),
    reportWindowMs:
      override?.reportWindowMs ?? base?.reportWindowMs ?? DEFAULT_FOLLOW_TRIAGE_REPORT_WINDOW_MS,
  }
}

/** The daemon-level default: triage OFF, every rule ON. */
export function defaultFollowTriageConfig(): FollowTriageConfig {
  return {
    enabled: false,
    rules: { ...DEFAULT_FOLLOW_TRIAGE_RULES },
    reportWindowMs: DEFAULT_FOLLOW_TRIAGE_REPORT_WINDOW_MS,
  }
}

// ── Events & facts ────────────────────────────────────────────────────

/** The event as the triage sees it — the digest entry plus the few facts
 *  that only exist at event time. */
export interface TriageEvent {
  /** The session that would be woken. */
  follower: string
  event: FollowEvent
  /** The session the event is ABOUT (the turn-end's session, the PR's
   *  author, the task-change's actor). */
  sessionId: string
  ts: string
  label?: string
  detail?: string
  key?: string
  boardId?: string
  taskId?: string
  /** `turn-end` / `awaiting-input`: the session is waiting on the human. */
  awaitingInput?: boolean
  /** `turn-end`: the turn produced no output at all. */
  empty?: boolean
  /** `turn-end` reason (`cancelled`, `error`, …) or `exited` reason
   *  (`operator-stopped`, …). */
  reason?: string
}

/**
 * The facts the engine knows and the event itself does not carry. All of
 * them are optional: a missing fact means "unknown", never "true".
 */
export interface TriageFacts {
  /** Did this session send a `message_parent` to the follower within the
   *  report window preceding the event? */
  reportedRecently?: (event: TriageEvent, windowMs: number) => boolean
  /** Is this session a LIVE session of the follower (the follower itself or
   *  one of its descendants)? */
  isFollowerSession?: (sessionId: string, follower: string) => boolean
  /** Was this turn-end followed by a NEW turn of the same session? */
  supersededByNewTurn?: (event: TriageEvent) => boolean
  /** Did this session's cron run finish OK? */
  cronOk?: (sessionId: string) => boolean | undefined
}

/** The outcome of classifying one event. `rule` names the rule that fired
 *  (`"default"` when nothing matched). */
export interface TriageResult {
  decision: TriageDecision
  rule: string
}

/** Rule ids — the vocabulary the JSONL ledger is written in. */
export const TRIAGE_RULES = {
  alwaysWake: "always-wake",
  ownTaskChanges: "own-task-changed",
  operatorExit: "operator-exit",
  cronOk: "cron-ok",
  reportedTurnEnd: "reported-turn-end",
  emptyTurnEnd: "empty-turn-end",
  ownPr: "own-pr",
  default: "default",
} as const

/** Exit reasons that mean "somebody asked this session to stop" — the
 *  operator or the follower itself. */
const OPERATOR_EXIT_REASONS: ReadonlySet<string> = new Set(["operator-stopped", "operator-completed"])

/**
 * The deterministic rules. Pure: same event + same facts ⇒ same decision.
 *
 * Order matters and is fixed:
 *  1. always-wake (never overridable),
 *  2. the six operator-tunable rules, in declaration order,
 *  3. default → `wake`.
 */
export function classifyFollowEvent(
  event: TriageEvent,
  rules: FollowTriageRules,
  facts: TriageFacts = {},
  reportWindowMs: number = DEFAULT_FOLLOW_TRIAGE_REPORT_WINDOW_MS,
): TriageResult {
  // 1. Always wake: a session waiting on the human, a crash, or a turn-end
  //    that carries a question. Never downgraded, never dropped.
  if (
    event.event === "awaiting-input" ||
    event.event === "crashed" ||
    (event.event === "turn-end" && event.awaitingInput === true)
  ) {
    return { decision: "wake", rule: TRIAGE_RULES.alwaysWake }
  }

  // 2. The follower's own board writes are its own business.
  if (rules.ownTaskChanges && event.event === "task-changed" && event.sessionId === event.follower) {
    return { decision: "drop", rule: TRIAGE_RULES.ownTaskChanges }
  }

  // 3. A deliberate stop is not a wake-up: nobody is waiting on it.
  if (
    rules.operatorExit &&
    event.event === "exited" &&
    event.reason !== undefined &&
    OPERATOR_EXIT_REASONS.has(event.reason)
  ) {
    return { decision: "fyi", rule: TRIAGE_RULES.operatorExit }
  }

  // 4. A cron run that finished OK already reported itself.
  if (rules.cronOk && event.event === "exited" && facts.cronOk?.(event.sessionId) === true) {
    return { decision: "drop", rule: TRIAGE_RULES.cronOk }
  }

  // 5. The turn-end of a session that just reported up: the echo of a
  //    message the follower already has.
  if (
    rules.reportedTurnEnd &&
    event.event === "turn-end" &&
    facts.reportedRecently?.(event, reportWindowMs) === true
  ) {
    return { decision: "drop", rule: TRIAGE_RULES.reportedTurnEnd }
  }

  // 6. An empty/cancelled turn-end that a new turn superseded: noise.
  if (
    rules.emptyTurnEnd &&
    event.event === "turn-end" &&
    (event.empty === true || event.reason === "cancelled") &&
    facts.supersededByNewTurn?.(event) === true
  ) {
    return { decision: "fyi", rule: TRIAGE_RULES.emptyTurnEnd }
  }

  // 7. A PR opened by one of the follower's OWN live sessions: the
  //    follower will hear about it from there.
  if (
    rules.ownPr &&
    (event.event === "pr-opened" || event.event === "pr-merged") &&
    facts.isFollowerSession?.(event.sessionId, event.follower) === true
  ) {
    return { decision: "fyi", rule: TRIAGE_RULES.ownPr }
  }

  return { decision: "wake", rule: TRIAGE_RULES.default }
}

// ── Classifier hook ───────────────────────────────────────────────────

export interface ClassifierOutcome {
  decision?: TriageDecision
  /** Why the classifier failed (timeout, non-zero exit, unparsable body). */
  error?: string
}

/** Parse a classifier answer: a bare `wake`/`fyi`/`drop`, or JSON carrying
 *  a `decision` field. */
export function parseClassifierAnswer(body: string): TriageDecision | undefined {
  const text = body.trim()
  if (isTriageDecision(text.toLowerCase())) return text.toLowerCase() as TriageDecision
  try {
    const parsed = JSON.parse(text) as { decision?: unknown }
    if (isTriageDecision(parsed.decision)) return parsed.decision
  } catch {
    /* not JSON — fall through */
  }
  return undefined
}

/**
 * Run the classifier hook for one event. Never throws: a failure is
 * reported as `error` so the caller can fall back to the rules.
 */
export async function runFollowTriageClassifier(
  event: TriageEvent,
  classifier: FollowTriageClassifier,
): Promise<ClassifierOutcome> {
  const timeoutMs = classifier.timeoutMs ?? DEFAULT_FOLLOW_TRIAGE_CLASSIFIER_TIMEOUT_MS
  const payload = JSON.stringify(event)
  try {
    if (classifier.command) {
      return await runCommandClassifier(classifier.command, payload, timeoutMs)
    }
    if (classifier.url) {
      return await runUrlClassifier(classifier.url, payload, timeoutMs)
    }
    return { error: "no classifier configured" }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function runCommandClassifier(
  command: string,
  payload: string,
  timeoutMs: number,
): Promise<ClassifierOutcome> {
  return new Promise<ClassifierOutcome>(resolve => {
    let settled = false
    const finish = (outcome: ClassifierOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] })
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
      finish({ error: `classifier timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    timer.unref?.()
    let out = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.stderr?.on("data", () => {
      /* stderr is not part of the contract */
    })
    child.on("error", err => finish({ error: err.message }))
    child.on("close", code => {
      const decision = parseClassifierAnswer(out)
      if (decision) finish({ decision })
      else finish({ error: `classifier produced no decision (exit ${code ?? "?"})` })
    })
    try {
      child.stdin?.end(payload)
    } catch {
      /* the close handler reports the failure */
    }
  })
}

async function runUrlClassifier(
  url: string,
  payload: string,
  timeoutMs: number,
): Promise<ClassifierOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      signal: controller.signal,
    })
    const body = await res.text()
    if (!res.ok) return { error: `classifier HTTP ${res.status}` }
    const decision = parseClassifierAnswer(body)
    return decision ? { decision } : { error: "classifier produced no decision" }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Classify one event, consulting the classifier hook when one is
 * configured. The classifier may refine a rule decision, but it can never
 * override an always-wake event, and any failure falls back to the rules.
 */
export async function triageFollowEvent(
  event: TriageEvent,
  config: FollowTriageConfig,
  facts: TriageFacts = {},
): Promise<TriageResult> {
  const base = classifyFollowEvent(event, config.rules, facts, config.reportWindowMs)
  if (!config.classifier) return base
  // Always-wake events are a hard invariant of the rules — the classifier
  // does not get to silence a session that is waiting on the human.
  if (base.rule === TRIAGE_RULES.alwaysWake) return base
  const outcome = await runFollowTriageClassifier(event, config.classifier)
  if (!outcome.decision) return base
  return { decision: outcome.decision, rule: `classifier:${base.rule}` }
}
