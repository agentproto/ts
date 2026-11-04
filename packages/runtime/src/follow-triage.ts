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

import {
  computeLevel,
  levelFromDecision,
  type Classifier,
  type ClassifyContext,
  type Envelope,
  type Floor,
  type Level,
} from "@agentproto/delivery"

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

/** The triage block a FOLLOW may carry. No `classifier`: that hook runs a
 *  command / HTTP call on the daemon host, so it is operator-owned
 *  (`~/.agentproto/config.json`) and never reachable from a tool call. */
export type FollowTriageFollowInput = Omit<FollowTriageInput, "classifier">

/** Resolve a partial triage block against the daemon-level default. */
export function resolveFollowTriageConfig(
  base?: FollowTriageConfig,
  override?: FollowTriageFollowInput,
): FollowTriageConfig {
  const baseRules = base?.rules ?? DEFAULT_FOLLOW_TRIAGE_RULES
  return {
    enabled: override?.enabled ?? base?.enabled ?? false,
    rules: { ...baseRules, ...(override?.rules ?? {}) },
    ...(base?.classifier ? { classifier: base.classifier } : {}),
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
  /** The level-3 pin, carried by the envelope the producer built. */
  floor?: Floor
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
  /** The computed level (3 only when the envelope carries a floor). */
  level?: Level
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

/**
 * The floor a follow event pins, if any: awaiting input and a turn-end that
 * carries a question are `awaiting-human`; a crash is `crash`. This is the
 * single source of the always-wake set. `computeLevel` turns it into level 3.
 */
export function followFloor(event: FollowEvent, awaitingInput?: boolean): Floor | undefined {
  if (event === "crashed") return "crash"
  if (event === "awaiting-input" || (event === "turn-end" && awaitingInput === true)) {
    return "awaiting-human"
  }
  return undefined
}

/** Exit reasons that mean "somebody asked this session to stop" — the
 *  operator or the follower itself. Deliberately narrower than
 *  `DELIBERATE_END_REASONS` (session-end-reason.ts): a steward-completed /
 *  steward-abandoned exit is an outcome the follower still wants to hear. */
const OPERATOR_EXIT_REASONS: ReadonlySet<string> = new Set(["operator-stopped", "operator-completed"])

/**
 * The deterministic rules. Pure: same event + same facts ⇒ same decision.
 *
 * Order matters and is fixed:
 *  1. a floored event (never overridable),
 *  2. the six operator-tunable rules, in declaration order,
 *  3. default → `wake`.
 */
export function classifyFollowEvent(
  event: TriageEvent,
  rules: FollowTriageRules,
  facts: TriageFacts = {},
  reportWindowMs: number = DEFAULT_FOLLOW_TRIAGE_REPORT_WINDOW_MS,
): TriageResult {
  // 1. A floored event (a session waiting on the human, a crash, or a
  //    turn-end that carries a question) is never downgraded or dropped.
  if ((event.floor ?? followFloor(event.event, event.awaitingInput)) !== undefined) {
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
    child.stdin?.on("error", () => {
      /* a classifier may exit without reading stdin (EPIPE); close reports the outcome */
    })
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

function decisionForLevel(level: Level): TriageDecision {
  if (level >= 2) return "wake"
  if (level === 1) return "fyi"
  return "drop"
}

/**
 * Apply a decision through `computeLevel`: the envelope's floor always wins,
 * so this is the ONE place a level-3 pin is honoured. Every other path reads
 * the level this returns, never a separate must-wake branch.
 */
export function levelOfDecision(
  event: Pick<TriageEvent, "floor" | "event" | "awaitingInput">,
  decision: TriageDecision,
  cap: Level = 3,
): Level {
  const hint = levelFromDecision(decision)
  return computeLevel(
    { floor: event.floor ?? followFloor(event.event, event.awaitingInput), levelHint: hint },
    hint,
    cap,
  )
}

/**
 * The deterministic verdict plus its computed level. Pure: same event + same
 * facts ⇒ same result. A floored event always comes back as level 3 and is
 * named `always-wake`, whatever the tunable rules would otherwise say.
 */
export function evaluateFollowEvent(
  event: TriageEvent,
  rules: FollowTriageRules,
  facts: TriageFacts = {},
  reportWindowMs: number = DEFAULT_FOLLOW_TRIAGE_REPORT_WINDOW_MS,
  cap: Level = 3,
): TriageResult & { level: Level } {
  const base = classifyFollowEvent(event, rules, facts, reportWindowMs)
  const level = levelOfDecision(event, base.decision, cap)
  return {
    decision: decisionForLevel(level),
    rule: level === 3 ? TRIAGE_RULES.alwaysWake : base.rule,
    level,
  }
}

/**
 * Classify one event, consulting the classifier hook when one is
 * configured. The hook may refine a non-floored decision; a floored event
 * is decided by `computeLevel` and any failure falls back to the rules.
 */
export async function triageFollowEvent(
  event: TriageEvent,
  config: FollowTriageConfig,
  facts: TriageFacts = {},
): Promise<TriageResult & { level: Level }> {
  const base = evaluateFollowEvent(event, config.rules, facts, config.reportWindowMs)
  if (!config.classifier) return base
  // The floor is already computed into `base.level`; a classifier can never
  // silence an event that is waiting on the human.
  if (base.level === 3) return base
  const outcome = await runFollowTriageClassifier(event, config.classifier)
  if (!outcome.decision) return base
  const level = levelOfDecision(event, outcome.decision)
  return { decision: decisionForLevel(level), rule: `classifier:${base.rule}`, level }
}

// ── The session-lifecycle classifier ──────────────────────────────────

/** Stable classifier id, recorded in the delivery ledger as `rule`. */
export const SESSION_LIFECYCLE_CLASSIFIER_ID = "session-lifecycle"

/** The CloudEvents type each follow event maps to. Kept in lockstep with the
 *  `session` sentinel provider's vocabulary (`session.awaiting_input`,
 *  `session.turn.ended`, `session.exited`). */
const FOLLOW_ENVELOPE_TYPES: Record<FollowEvent, string> = {
  "turn-end": "session.turn.ended",
  "awaiting-input": "session.awaiting_input",
  exited: "session.exited",
  crashed: "session.crashed",
  "pr-opened": "session.pr_opened",
  "pr-merged": "session.pr_merged",
  "task-changed": "session.task_changed",
}

const ENVELOPE_TYPE_TO_EVENT = new Map<string, FollowEvent>(
  Object.entries(FOLLOW_ENVELOPE_TYPES).map(([event, type]) => [type, event as FollowEvent]),
)

/** The delivery envelope `type` for a follow event. */
export function followEnvelopeType(event: FollowEvent): string {
  return FOLLOW_ENVELOPE_TYPES[event]
}

/** Rebuild the rule-layer event from the producer's envelope. */
export function triageEventFromEnvelope(env: Envelope, follower: string): TriageEvent {
  const event = ENVELOPE_TYPE_TO_EVENT.get(env.type)
  if (event === undefined) {
    throw new Error(`not a session-lifecycle envelope type: ${env.type}`)
  }
  const data = env.data
  const fromData = (key: string): string | undefined =>
    typeof data[key] === "string" ? (data[key] as string) : undefined
  return {
    follower,
    event,
    sessionId: fromData("sessionId") ?? env.about?.sessionId ?? env.subject.replace(/^session:/, ""),
    ts: env.time,
    ...(fromData("label") ? { label: fromData("label")! } : {}),
    ...(fromData("detail") ? { detail: fromData("detail")! } : {}),
    ...(fromData("key") ? { key: fromData("key")! } : {}),
    ...(fromData("boardId") ? { boardId: fromData("boardId")! } : {}),
    ...(fromData("taskId") ? { taskId: fromData("taskId")! } : {}),
    ...(typeof data.awaitingInput === "boolean" ? { awaitingInput: data.awaitingInput } : {}),
    ...(typeof data.empty === "boolean" ? { empty: data.empty } : {}),
    ...(fromData("reason") ? { reason: fromData("reason")! } : {}),
    ...(env.floor !== undefined ? { floor: env.floor } : {}),
  }
}

export interface SessionLifecycleClassifierOptions {
  rules: FollowTriageRules
  /** The engine facts, closed over here (never threaded through
   *  `ClassifyContext`, which no longer carries them). */
  facts?: TriageFacts
  reportWindowMs?: number
  /** Follower whose events these are; defaults to `ctx.targetId`. */
  follower?: string
}

/** Build the `session-lifecycle` classifier over the follow rules. */
export function createSessionLifecycleClassifier(
  options: SessionLifecycleClassifierOptions,
): Classifier {
  const facts = options.facts ?? {}
  const reportWindowMs = options.reportWindowMs ?? DEFAULT_FOLLOW_TRIAGE_REPORT_WINDOW_MS
  const classify = (env: Envelope, ctx: ClassifyContext): Level =>
    evaluateFollowEvent(
      triageEventFromEnvelope(env, options.follower ?? ctx.targetId),
      options.rules,
      facts,
      reportWindowMs,
    ).level
  return {
    id: SESSION_LIFECYCLE_CLASSIFIER_ID,
    types: Object.values(FOLLOW_ENVELOPE_TYPES),
    classify,
  }
}
