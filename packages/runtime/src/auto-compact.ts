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
 *   - After the compaction, a short resume prompt is injected ONLY when a
 *     mission is in progress. "A mission is in progress" is decided by the
 *     caller (the daemon reads it off the continuity checkpoint written
 *     just before the compaction: a non-empty `goal` section means there is
 *     a goal to resume). A session with no goal still gets its context
 *     freed. It is just not told to carry on.
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

/** The result of the compaction request the controller made. */
export interface AutoCompactOutcome {
  /** Whether a mission was in progress (the caller decides how). */
  missionInProgress: boolean
  /** The mission's goal text, when there is one. */
  goal?: string
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
 * Build the resume prompt injected after an automatic compaction.
 *
 * Short by construction (it is billed like any other prompt): the mission
 * (when known), the instruction to carry on, and the path of the FULL
 * transcript so the session can look anything up that the summary dropped.
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
  lines.push(`Full transcript: ${input.transcriptPath}`)
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
  // A compaction only re-arms once the context has actually dropped below
  // the threshold: a harness that reports a compacted-but-unchanged usage
  // figure must not put the session into a compaction loop.
  let armed = true
  return {
    get inFlight() {
      return inFlight
    },
    async maybeTrigger(): Promise<AutoCompactDecision> {
      const tokens = deps.readTokens()
      const threshold = clampAutoCompactTokens(deps.readThreshold())
      if (!armed) {
        if (tokens !== undefined && tokens < threshold) armed = true
        else {
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
        if (outcome.missionInProgress) {
          const prompt = buildAutoCompactResumePrompt({
            ...(outcome.goal !== undefined ? { goal: outcome.goal } : {}),
            transcriptPath: deps.transcriptPath(),
          })
          deps.log?.("[auto-compact] mission in progress: injecting the resume prompt")
          await deps.requestResume(prompt)
        } else {
          deps.log?.("[auto-compact] no mission in progress: no resume prompt")
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
