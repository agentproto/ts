/**
 * Autocompact: an ABSOLUTE token threshold that compacts a session's
 * context while it is idle, plus the short resume prompt that puts the
 * session back on its mission afterwards.
 *
 * Why an absolute threshold at all: the percent-based continuity policy
 * (`contextContinuity.warnAtPct` / `compactAtPct` / …) never fires on a
 * session with a very large context window. A 1M-token window that has
 * grown to 558k tokens is "55% full" (the warn band, not the compact
 * band), while every single call re-reads ~330k cached tokens. The percent
 * ladder cannot see that, so nothing compacts and the bill grows. An
 * absolute token threshold is window-independent: 150k tokens of context is
 * 150k tokens of context whether the window is 200k or 1M.
 *
 * The rules this module encodes (all pure, all testable):
 *
 *   - The threshold is clamped to `[AUTO_COMPACT_MIN_TOKENS,
 *     AUTO_COMPACT_MAX_TOKENS]`. A value above the maximum is clamped down
 *     (never rejected), a value of `0` disables autocompact, and an absent
 *     value resolves to {@link AUTO_COMPACT_DEFAULT_TOKENS}.
 *   - Autocompact only fires on an IDLE session (the turn ended and no
 *     background task is outstanding). A busy session is mid-flight; its
 *     context is the live turn's context, and compacting under it would
 *     corrupt the turn.
 *   - It never fires twice for the same compaction: while a compaction is
 *     in flight the controller reports `already-compacting` and does
 *     nothing.
 *   - The context-continuity MODE does not gate autocompact. `manual`
 *     suppresses the percent ladder's nudges (warn / compact /
 *     continue-fresh), but autocompact is an absolute, cost-driven guard in
 *     the same family as the hard-stop floor: a session that never
 *     compacts is a session that re-reads its whole context on every
 *     call. A session that wants neither sets `autoCompactAtTokens: 0`.
 *   - After the compaction, a short resume prompt is injected ONLY when the
 *     session really had WORK IN PROGRESS at the moment of the compaction.
 *     That is decided by {@link hasWorkInProgress} on a snapshot of the
 *     runtime state captured BEFORE the `/compact` prompt went out: a
 *     background task outstanding, a tool call still unanswered (a parked
 *     permission request or a tool awaiting a result), or a last turn that
 *     ended on an error, a cancellation or an interruption. The session
 *     TITLE and the checkpoint's goal text are NEVER the trigger: the goal
 *     falls back to the title, so a title-based rule wakes every idle
 *     session and spends a turn for nothing. The goal survives only as
 *     optional TEXT inside the resume prompt.
 *   - The compaction always carries the full transcript path and a
 *     reminder that `transcript_search` / `transcript_read` exist, so the
 *     agent can look up whatever the summary dropped. Harnesses whose
 *     compact command takes instructions carry it there (claude-code:
 *     `/compact <instructions>`); for the others the same one-line
 *     reminder rides along with the NEXT user prompt the session receives
 *     (a pending note consumed once), never as a turn of its own.
 */

/** Default absolute threshold: 150k tokens of context. */
export const AUTO_COMPACT_DEFAULT_TOKENS = 150_000
/** Hard ceiling for the threshold: a session never autocompacts above it. */
export const AUTO_COMPACT_MAX_TOKENS = 200_000
/** Floor for a non-zero threshold (below this the threshold is noise). */
export const AUTO_COMPACT_MIN_TOKENS = 1_000

/**
 * Clamp a user-supplied absolute threshold.
 *
 * - `undefined` / `null` / non-finite → {@link AUTO_COMPACT_DEFAULT_TOKENS}
 * - `<= 0` → `0` (autocompact disabled)
 * - otherwise → clamped into `[AUTO_COMPACT_MIN_TOKENS,
 *   AUTO_COMPACT_MAX_TOKENS]`
 */
export function clampAutoCompactTokens(value: number | undefined | null): number {
  if (value === undefined || value === null) return AUTO_COMPACT_DEFAULT_TOKENS
  if (!Number.isFinite(value)) return AUTO_COMPACT_DEFAULT_TOKENS
  if (value <= 0) return 0
  return Math.min(Math.max(Math.round(value), AUTO_COMPACT_MIN_TOKENS), AUTO_COMPACT_MAX_TOKENS)
}

/**
 * After a compaction, the controller re-arms once the context has grown by
 * this fraction of the threshold (at least {@link AUTO_COMPACT_MIN_TOKENS})
 * past the lowest reading seen since, even without a sub-threshold reading.
 */
const AUTO_COMPACT_REARM_GROWTH_FRACTION = 0.25

function readFiniteTokens(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined
}

/** Why autocompact did (not) fire. */
export type AutoCompactReason =
  | "above-threshold"
  | "disabled"
  | "unknown-tokens"
  | "below-threshold"
  | "not-idle"
  | "background-task"
  | "already-compacting"
  | "awaiting-drop"

/** The inputs of one autocompact decision. */
export interface AutoCompactInputs {
  /** Tokens currently held in the session's context. */
  tokens: number | undefined
  /** Configured absolute threshold. {@link decideAutoCompact} clamps it
   *  again, so a raw (unclamped) value is safe here. */
  threshold: number | undefined
  /** The session is between turns (not mid-turn). */
  idle: boolean
  /** A background task is outstanding: the session is not idle. */
  backgroundTask: boolean
  /** A compaction is already in flight. */
  compacting: boolean
}

/** The outcome of one autocompact decision. */
export interface AutoCompactDecision {
  /** Whether autocompact should run now. */
  trigger: boolean
  /** Why (the trigger reason when `trigger` is true). */
  reason: AutoCompactReason
  /** The effective (clamped) threshold. */
  threshold: number
  /** The token reading the decision was made on. */
  tokens: number
}

/**
 * Decide whether an idle session above the absolute threshold should be
 * compacted now. Pure: no I/O, no timers, no side effects.
 */
export function decideAutoCompact(inputs: AutoCompactInputs): AutoCompactDecision {
  const threshold = clampAutoCompactTokens(inputs.threshold)
  const tokens = inputs.tokens ?? 0
  const base = { threshold, tokens }
  if (threshold === 0) return { trigger: false, reason: "disabled", ...base }
  if (inputs.compacting) return { trigger: false, reason: "already-compacting", ...base }
  if (inputs.tokens === undefined || !Number.isFinite(inputs.tokens)) {
    return { trigger: false, reason: "unknown-tokens", ...base }
  }
  if (!inputs.idle) return { trigger: false, reason: "not-idle", ...base }
  if (inputs.backgroundTask) return { trigger: false, reason: "background-task", ...base }
  if (inputs.tokens < threshold) return { trigger: false, reason: "below-threshold", ...base }
  return { trigger: true, reason: "above-threshold", ...base }
}

/**
 * How the session's last turn ended, as the runtime saw it.
 *
 * `unknown` is a real case: a session whose first turn never produced a
 * turn-end (or whose descriptor was reloaded without the marker) has no
 * outcome to report, and "no outcome" is NOT work in progress.
 */
export type LastTurnOutcome =
  | "completed"
  | "error"
  | "cancelled"
  | "interrupted"
  | "unknown"

/**
 * The runtime state, captured BEFORE the `/compact` prompt is sent, that
 * decides whether the session really had work in progress.
 *
 * The snapshot is taken before the compaction on purpose: the compaction is
 * itself a turn, and it OVERWRITES the turn-end markers
 * (`lastTurnReason` / `lastTurnErroredAt`) and clears `awaitingInput`. Read
 * after it, every session would look like a clean, completed turn.
 */
export interface WorkInProgressSnapshot {
  /** A background task is outstanding for the session. */
  backgroundTaskOutstanding: boolean
  /** A tool call is open and unanswered (or a permission request is parked). */
  pendingToolCall: boolean
  /** The session asked something (or asked for a permission) and the
   *  answer has not come yet. */
  awaitingInput: boolean
  /** How the last turn ended. */
  lastTurnOutcome: LastTurnOutcome
}

/**
 * Derive how the last turn ended, from the turn-end markers the runtime
 * keeps. Pure: the caller passes the markers in.
 *
 * The mapping is deliberately narrow: only a turn that DIED counts as work
 * in progress (see {@link hasWorkInProgress}). A clean `completed` turn, an
 * unknown outcome (a session whose first turn never ended) and a
 * `max_turns` stop all mean "nothing was interrupted".
 */
export function deriveLastTurnOutcome(input: {
  /** The turn-end reason reported by the adapter (`completed`, `cancelled`,
   *  `error`, `watchdog-timeout`, …) or synthesized by the runtime. */
  reason?: string
  /** True when the adapter reported a turn-level error. */
  errored?: boolean
  /** True when the turn was cut short (killed mid-turn, daemon restart). */
  interrupted?: boolean
}): LastTurnOutcome {
  if (input.interrupted) return "interrupted"
  switch (input.reason) {
    case "error":
      return "error"
    case "cancelled":
      return "cancelled"
    case "aborted":
      return "interrupted"
    case "watchdog-timeout":
      return "error"
    case "completed":
      return input.errored ? "error" : "completed"
    default:
      return input.errored ? "error" : "unknown"
  }
}

/**
 * Whether a harness's compaction command takes INSTRUCTIONS as an argument.
 *
 * `claude-code`'s CLI accepts `/compact <instructions>` (the adapter
 * advertises the command with an input hint: "optional context about what
 * to preserve"), so the summary can be told where the full transcript is.
 * The other adapters dispatch the compaction by NAME only, opencode
 * routes `/compact` to `session.summarize`, hermes matches
 * `_handle_slash_command`, codex has no argument-taking compaction command
 * in this repo, so trailing text there is not an instruction. Those
 * harnesses get the reminder as a pending note on the next prompt instead.
 */
export function compactCommandTakesInstructions(harness: string | undefined): boolean {
  const slug = (harness ?? "").trim().toLowerCase()
  return slug === "claude-code"
}

/**
 * The rule that decides whether the resume prompt is sent after an
 * automatic compaction. Pure: no I/O, no timers, no side effects.
 *
 * A resume prompt is only worth a turn when the session was in the middle
 * of something: a background task still running, a tool call still open, a
 * question still unanswered, or a turn that died on an error, a
 * cancellation or an interruption. An idle session that finished its work
 * (or never started any) gets its context freed and nothing else: waking it
 * up would spend a turn and a model call for nothing.
 *
 * The session title and the checkpoint's goal text are NEVER consulted
 * here. The goal falls back to the title, so a goal-based rule fires on
 * essentially every session; the goal survives only as optional text
 * inside the resume prompt.
 */
export function hasWorkInProgress(snapshot: WorkInProgressSnapshot): boolean {
  if (snapshot.backgroundTaskOutstanding) return true
  if (snapshot.pendingToolCall) return true
  if (snapshot.awaitingInput) return true
  return (
    snapshot.lastTurnOutcome === "error" ||
    snapshot.lastTurnOutcome === "cancelled" ||
    snapshot.lastTurnOutcome === "interrupted"
  )
}

/** The result of the compaction request the controller made. */
export interface AutoCompactOutcome {
  /** The mission's goal text, when there is one. Optional TEXT only: it
   *  never decides whether the resume prompt is sent. */
  goal?: string
  /** The runtime state captured BEFORE the `/compact` prompt was sent,
   *  the only input to {@link hasWorkInProgress}. */
  snapshot: WorkInProgressSnapshot
}

/** The hooks the controller drives: every side effect lives behind them. */
export interface AutoCompactControllerDeps {
  /** Current context size in tokens (undefined when unknown). */
  readTokens: () => number | undefined
  /** Configured absolute threshold. */
  readThreshold: () => number | undefined
  /** True between turns. */
  isIdle: () => boolean
  /** True while a background task is outstanding. */
  hasBackgroundTask: () => boolean
  /** True while a compaction is already running (elsewhere). */
  isCompacting: () => boolean
  /** Ask the harness to compact; resolves with the mission state. */
  requestCompact: () => Promise<AutoCompactOutcome>
  /** Deliver the resume prompt. */
  requestResume: (prompt: string) => Promise<void>
  /** Absolute path of the full transcript, cited by the resume prompt. */
  transcriptPath: () => string
  /** Optional log sink (the daemon writes these to the transcript). */
  log?: (line: string) => void
}

/** The autocompact controller for one session. */
export interface AutoCompactController {
  /** Evaluate and, if warranted, run one autocompact. */
  maybeTrigger: () => Promise<AutoCompactDecision>
  /** True while a compaction is in flight. */
  readonly inFlight: boolean
}

/**
 * The one-line reminder that tells the session where the FULL transcript
 * is and how to look things up in it.
 *
 * It is the same line everywhere it appears: in the compaction instructions
 * of a harness whose compact command takes arguments, in the pending note
 * prepended to the next prompt of a harness whose compact command does not,
 * and in the resume prompt.
 */
export function buildAutoCompactTranscriptNote(transcriptPath: string): string {
  return `Full transcript: ${transcriptPath}. Use transcript_search / transcript_read to look up anything dropped.`
}

/**
 * The instructions handed to the compaction itself, for a harness whose
 * compact command takes an argument (claude-code: `/compact <instructions>`).
 *
 * They ask the summary to keep the transcript path and to mention the two
 * lookup tools, so the compacted context still says where everything went.
 */
export function buildAutoCompactCompactInstructions(input: {
  transcriptPath: string
  focus?: string
}): string {
  const focus = input.focus?.trim()
  const parts = [
    focus ?? "Keep the current goal, open tasks and decisions in the summary.",
    buildAutoCompactTranscriptNote(input.transcriptPath),
  ]
  return parts.join(" ")
}

/**
 * Build the resume prompt injected after an automatic compaction.
 *
 * Short by construction (it is billed like any other prompt): the mission
 * (when known), the instruction to carry on, and the path of the FULL
 * transcript plus the two lookup tools, so the session can recover
 * anything the summary dropped.
 */
export function buildAutoCompactResumePrompt(input: {
  goal?: string
  transcriptPath: string
}): string {
  const goal = input.goal?.trim()
  const lines = [
    "[auto-compact] Context was compacted automatically (absolute token threshold reached).",
  ]
  if (goal) lines.push(`Mission: ${goal}`)
  lines.push(
    "Resume the mission from where you left off; the summary above is what survived the compaction.",
  )
  lines.push(buildAutoCompactTranscriptNote(input.transcriptPath))
  return lines.join("\n")
}

/**
 * Create the per-session autocompact controller.
 *
 * The controller is the single place that enforces "at most one compaction
 * in flight" for autocompact: while `maybeTrigger` runs, the controller
 * reports itself as compacting, so a second turn boundary cannot start a
 * second compaction.
 */
export function createAutoCompactController(
  deps: AutoCompactControllerDeps,
): AutoCompactController {
  let inFlight = false
  // After a compaction the controller disarms so a harness that reports a
  // compacted-but-unchanged usage figure cannot put the session into a
  // compaction loop. It re-arms when the context drops below the threshold,
  // OR when it grows materially past the lowest reading seen since the
  // compaction (`floor`): a harness that ignores `/compact`, or a resumed
  // turn that regrows the context before a sub-threshold reading is ever
  // sampled, must not leave the session above the threshold forever.
  let armed = true
  let floor: number | undefined
  return {
    get inFlight() {
      return inFlight
    },
    async maybeTrigger(): Promise<AutoCompactDecision> {
      const tokens = deps.readTokens()
      const threshold = clampAutoCompactTokens(deps.readThreshold())
      if (!armed) {
        if (tokens !== undefined && Number.isFinite(tokens)) {
          floor = floor === undefined ? tokens : Math.min(floor, tokens)
        }
        const growth = Math.max(
          AUTO_COMPACT_MIN_TOKENS,
          Math.round(threshold * AUTO_COMPACT_REARM_GROWTH_FRACTION),
        )
        if (
          tokens !== undefined &&
          (tokens < threshold || (floor !== undefined && tokens >= floor + growth))
        ) {
          armed = true
          floor = undefined
        } else {
          return {
            trigger: false,
            reason: "awaiting-drop",
            threshold,
            tokens: tokens ?? 0,
          }
        }
      }
      const decision = decideAutoCompact({
        tokens,
        threshold,
        idle: deps.isIdle(),
        backgroundTask: deps.hasBackgroundTask(),
        compacting: inFlight || deps.isCompacting(),
      })
      if (!decision.trigger) return decision
      inFlight = true
      try {
        deps.log?.(
          `[auto-compact] context at ${decision.tokens} tokens (threshold ${decision.threshold}): compacting automatically`,
        )
        const outcome = await deps.requestCompact()
        armed = false
        floor = readFiniteTokens(deps.readTokens()) ?? decision.tokens
        // The snapshot was captured BEFORE the compaction went out (the
        // compaction is a turn of its own and overwrites the turn-end
        // markers), so it still says whether the session had work in
        // progress when it was compacted.
        if (hasWorkInProgress(outcome.snapshot)) {
          const prompt = buildAutoCompactResumePrompt({
            ...(outcome.goal !== undefined ? { goal: outcome.goal } : {}),
            transcriptPath: deps.transcriptPath(),
          })
          deps.log?.("[auto-compact] work in progress: injecting the resume prompt")
          await deps.requestResume(prompt)
        } else {
          deps.log?.("[auto-compact] nothing in progress: no resume prompt")
        }
      } catch (err) {
        deps.log?.(
          `[auto-compact] failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      } finally {
        inFlight = false
      }
      return decision
    },
  }
}
