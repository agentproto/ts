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
 *   - Autocompact is OPT-IN. With no threshold configured it never fires:
 *     an absent (or non-finite) value resolves to `0`, disabled. A session
 *     opts in by setting `contextContinuity.autoCompactAtTokens`.
 *   - A non-zero threshold is floored at `AUTO_COMPACT_MIN_TOKENS` (below
 *     that it is noise). There is no ceiling: a session on a 1M-token
 *     window may set a threshold above 200k. A value of `0` disables.
 *   - The context-continuity mode `manual` disables autocompact (see
 *     {@link effectiveAutoCompactTokens}): `manual` means "nothing happens
 *     to my context unless I ask", and that includes this.
 *   - Autocompact only fires on an IDLE session (the turn ended and no
 *     background task is outstanding). A busy session is mid-flight; its
 *     context is the live turn's context, and compacting under it would
 *     corrupt the turn.
 *   - It never fires twice for the same compaction: while a compaction is
 *     in flight the controller reports `already-compacting` and does
 *     nothing.
 *   - After the compaction, a short resume prompt is injected ONLY when a
 *     mission is in progress. "A mission is in progress" is decided by the
 *     caller (the daemon reads it off the continuity checkpoint written
 *     just before the compaction: a non-empty `goal` section means there is
 *     a goal to resume). A session with no goal still gets its context
 *     freed. It is just not told to carry on.
 */

/** Floor for a non-zero threshold (below this the threshold is noise). */
export const AUTO_COMPACT_MIN_TOKENS = 1_000

/**
 * Clamp a user-supplied absolute threshold.
 *
 * - `undefined` / `null` / non-finite → `0` (autocompact is opt-in: off)
 * - `<= 0` → `0` (autocompact disabled)
 * - otherwise → rounded, floored at {@link AUTO_COMPACT_MIN_TOKENS}; no
 *   ceiling
 */
export function clampAutoCompactTokens(value: number | undefined | null): number {
  if (value === undefined || value === null) return 0
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  return Math.max(Math.round(value), AUTO_COMPACT_MIN_TOKENS)
}

/**
 * The threshold a session's policy actually arms: `0` (off) when the policy
 * is absent, sets no threshold, or is in `manual` mode; otherwise the
 * clamped `autoCompactAtTokens`.
 */
export function effectiveAutoCompactTokens(
  policy: { mode?: string; autoCompactAtTokens?: number } | undefined,
): number {
  if (!policy || policy.mode === "manual") return 0
  return clampAutoCompactTokens(policy.autoCompactAtTokens)
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
