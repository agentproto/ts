import {
  AUTO_COMPACT_DEFAULT_TOKENS,
  clampAutoCompactTokens,
} from "./auto-compact.js"

/**
 * Canonical context-continuity policy for long-running agent sessions.
 *
 * Provides a deterministic, testable policy engine with safe defaults and a
 * clear override order: global defaults → per-harness defaults →
 * per-model defaults → session override. The policy drives warnings,
 * opportunistic compaction, fresh continuation, and hard-stop decisions at
 * turn boundaries so sessions never silently run into the model context
 * limit.
 */

/**
 * `manual` suppresses every automatic *nudge* (warn/compact/continue-fresh —
 * see `contextContinuityNextAction`) so the session is left alone until the
 * caller acts. It does NOT suppress the floor (`hard-stop` state): that is an
 * unconditional safety net, independent of mode — its purpose is to stop a
 * session from silently running past the model's real context window
 * (further prompts would be truncated/rejected by the provider, or corrupt
 * the conversation) even when nothing is watching.
 *
 * The floor is a trigger, not an exit: the runtime first compacts the session
 * itself (checkpoint, then `/compact`), continues it fresh when that did not
 * free the window, and only ends it when neither is possible — always
 * announcing the outcome (`session:context-rescue`). A session that wants to
 * opt out of the floor should set `hardStopAtPct` above what it will ever
 * reach, not rely on mode.
 */
export type ContextContinuityMode = "manual" | "ask" | "auto"

export interface ContextContinuityThresholds {
  /** Percentage at which the UI first warns that context is filling. */
  warnAtPct: number
  /** Percentage at which an opportunistic compact may be attempted. */
  compactAtPct: number
  /** Percentage at which a fresh continuation session is created. */
  continueFreshAtPct: number
  /** Percentage above which no new prompt may be admitted. */
  hardStopAtPct: number
}

export interface ContextContinuityCheckpointSections {
  goal: boolean
  plan: boolean
  decisions: boolean
  changedFiles: boolean
  gitStatus: boolean
  tests: boolean
  errors: boolean
  risks: boolean
  nextStep: boolean
  config: boolean
}

/**
 * User-supplied policy fragment. Every field optional; missing values are
 * filled from the next precedence layer or from safe defaults.
 */
export interface ContextContinuityPolicy
  extends Partial<ContextContinuityThresholds>,
    Partial<ContextContinuityCheckpointSections> {
  mode?: ContextContinuityMode
  /**
   * Absolute token threshold for autocompact: when an IDLE session's
   * context reaches this many tokens, the daemon compacts it (the same
   * `/compact` path as `session_compact`) and, when a mission is in
   * progress, injects a short resume prompt.
   *
   * Window-independent by design: the percent ladder above never fires on
   * a 1M-token context (558k of 1M is "55% full", the warn band), so a
   * session can grow without ever compacting. An absolute count does not
   * care how big the window is.
   *
   * Clamped into `[1000, 600000]`; `0` disables autocompact. Unset = the
   * default (150k). */
  autoCompactAtTokens?: number
  /** Optional display label for UIs. */
  label?: string
  /** Suggest a cross-harness handoff (`session:handoff-suggested`) once the
   *  provider-reported remaining quota of the session's auth profile falls to
   *  or below this number. Same unit as the `remaining` figure
   *  `usage_rollup` shows per profile (Anthropic's unified rate-limit
   *  header — a count, not a percentage: the header carries no limit to
   *  divide by). Unset = disabled. Suggestion only, never a switch. */
  handoffAtQuotaRemaining?: number
  /** When true, a context-losing compaction prompt (`/compact`, `/compress`)
   *  is admitted only from the operator (a source-less prompt: HTTP, CLI,
   *  UI). One attributed to a session (`agent:<id>` — `agent_prompt`,
   *  `session_compact`, including the session itself) is refused. For a
   *  session whose compaction needs a human's agreement (the Pygmalion
   *  brain), so it can't be bypassed by a prompt-level self-compact. Unset
   *  = false. */
  compactRequiresOperator?: boolean
  /** When true, a `/compact` or `/compress` prompt asks the live session for
   *  a handoff turn (its own goal/decisions/risks) before the checkpoint is
   *  built, then the harness's native compaction runs on the same session.
   *  Unset = false: the checkpoint is extracted from the transcript alone,
   *  with no billed model turn before compaction. The context-rescue path
   *  (`runtime:context-rescue`) never asks. Unchanged explicit handoffs
   *  (`session_checkpoint`, `session_continue_fresh`) still ask. */
  compactHandoffTurn?: boolean
}

/**
 * Fully-resolved, validated policy. This is the shape stored on a session
 * descriptor and returned by status queries.
 */
export interface ResolvedContextContinuityPolicy
  extends ContextContinuityThresholds,
    Required<ContextContinuityCheckpointSections> {
  mode: ContextContinuityMode
  /** See {@link ContextContinuityPolicy.autoCompactAtTokens} (clamped).
   *  Optional so a policy persisted before autocompact existed still
   *  deserialises; absent = {@link AUTO_COMPACT_DEFAULT_TOKENS}. */
  autoCompactAtTokens?: number
  /** Effective label (falls back to mode when absent). */
  label: string
  /** See {@link ContextContinuityPolicy.handoffAtQuotaRemaining}. */
  handoffAtQuotaRemaining?: number
  /** See {@link ContextContinuityPolicy.compactRequiresOperator}. */
  compactRequiresOperator?: boolean
  /** See {@link ContextContinuityPolicy.compactHandoffTurn}. */
  compactHandoffTurn?: boolean
}

export const CONTEXT_CONTINUITY_DEFAULTS: ResolvedContextContinuityPolicy = {
  mode: "ask",
  autoCompactAtTokens: AUTO_COMPACT_DEFAULT_TOKENS,
  warnAtPct: 55,
  compactAtPct: 65,
  continueFreshAtPct: 75,
  hardStopAtPct: 90,
  goal: true,
  plan: true,
  decisions: true,
  changedFiles: true,
  gitStatus: true,
  tests: true,
  errors: true,
  risks: true,
  nextStep: true,
  config: true,
  label: "ask",
}

/** A session with no resolved policy is checkpointed, and continued fresh,
 *  under the defaults (the same way its pre-compaction checkpoint is). */
export function withContextPolicy<D extends { contextContinuity?: ResolvedContextContinuityPolicy }>(
  desc: D,
): { source: D; policy: ResolvedContextContinuityPolicy } {
  const policy = desc.contextContinuity ?? CONTEXT_CONTINUITY_DEFAULTS
  return { source: desc.contextContinuity ? desc : { ...desc, contextContinuity: policy }, policy }
}

export interface ContextContinuityStatus {
  sessionId: string
  contextSize?: number
  contextUsed?: number
  /** Null when no context window is known. */
  contextPct: number | null
  policy: ResolvedContextContinuityPolicy
  /** Current policy state. */
  state: ContextContinuityState
  /** Human-readable one-line summary for panels. */
  summary: string
  /** The action the runtime would take automatically at the next turn end. */
  nextAction: ContextContinuityNextAction
  /** Distance to the next threshold in percentage points (null if unknown). */
  nextThresholdDelta: number | null
  /** The effective ABSOLUTE autocompact threshold (tokens). 0 = disabled. */
  autoCompactAtTokens: number
  /** Whether the session is currently at or above the absolute threshold. */
  autoCompactAboveThreshold: boolean
}

export type ContextContinuityState =
  | "ok"
  | "warn"
  | "compact"
  | "continue-fresh"
  | "hard-stop"

export type ContextContinuityNextAction =
  | "none"
  | "warn"
  | "ask"
  | "compact"
  | "continue-fresh"
  | "hard-stop"

export type ContextContinuityValidationResult =
  | { ok: true }
  | { ok: false; reason: string }

function isIntInRange(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max
}

/**
 * Validate a policy fragment or resolved policy. Enforces:
 *   - all percentages are integers in [0, 100]
 *   - warnAtPct < compactAtPct < continueFreshAtPct < hardStopAtPct
 */
export function validateContextContinuityPolicy(
  p: Partial<ContextContinuityPolicy>,
): ContextContinuityValidationResult {
  if (
    p.handoffAtQuotaRemaining !== undefined &&
    !(Number.isFinite(p.handoffAtQuotaRemaining) && p.handoffAtQuotaRemaining >= 0)
  ) {
    return {
      ok: false,
      reason: `handoffAtQuotaRemaining must be a number >= 0, got ${p.handoffAtQuotaRemaining}`,
    }
  }

  const nums: Array<{ key: keyof ContextContinuityThresholds; value: number | undefined }> = [
    { key: "warnAtPct", value: p.warnAtPct },
    { key: "compactAtPct", value: p.compactAtPct },
    { key: "continueFreshAtPct", value: p.continueFreshAtPct },
    { key: "hardStopAtPct", value: p.hardStopAtPct },
  ]
  for (const { key, value } of nums) {
    if (value === undefined) continue
    if (!isIntInRange(value, 0, 100)) {
      return { ok: false, reason: `${key} must be an integer between 0 and 100, got ${value}` }
    }
  }

  const warn = p.warnAtPct ?? CONTEXT_CONTINUITY_DEFAULTS.warnAtPct
  const compact = p.compactAtPct ?? CONTEXT_CONTINUITY_DEFAULTS.compactAtPct
  const continueFresh = p.continueFreshAtPct ?? CONTEXT_CONTINUITY_DEFAULTS.continueFreshAtPct
  const hardStop = p.hardStopAtPct ?? CONTEXT_CONTINUITY_DEFAULTS.hardStopAtPct

  if (!(warn < compact)) {
    return { ok: false, reason: `warnAtPct (${warn}) must be < compactAtPct (${compact})` }
  }
  if (!(compact < continueFresh)) {
    return { ok: false, reason: `compactAtPct (${compact}) must be < continueFreshAtPct (${continueFresh})` }
  }
  if (!(continueFresh < hardStop)) {
    return { ok: false, reason: `continueFreshAtPct (${continueFresh}) must be < hardStopAtPct (${hardStop})` }
  }

  return { ok: true }
}

function mergePolicyLayer(
  base: ResolvedContextContinuityPolicy,
  override: ContextContinuityPolicy | undefined,
): ResolvedContextContinuityPolicy {
  if (!override) return base
  return {
    mode: override.mode ?? base.mode,
    autoCompactAtTokens: clampAutoCompactTokens(
      override.autoCompactAtTokens ?? base.autoCompactAtTokens,
    ),
    warnAtPct: override.warnAtPct ?? base.warnAtPct,
    compactAtPct: override.compactAtPct ?? base.compactAtPct,
    continueFreshAtPct: override.continueFreshAtPct ?? base.continueFreshAtPct,
    hardStopAtPct: override.hardStopAtPct ?? base.hardStopAtPct,
    goal: override.goal ?? base.goal,
    plan: override.plan ?? base.plan,
    decisions: override.decisions ?? base.decisions,
    changedFiles: override.changedFiles ?? base.changedFiles,
    gitStatus: override.gitStatus ?? base.gitStatus,
    tests: override.tests ?? base.tests,
    errors: override.errors ?? base.errors,
    risks: override.risks ?? base.risks,
    nextStep: override.nextStep ?? base.nextStep,
    config: override.config ?? base.config,
    label: override.label ?? base.label,
    ...((override.handoffAtQuotaRemaining ?? base.handoffAtQuotaRemaining) !== undefined
      ? { handoffAtQuotaRemaining: (override.handoffAtQuotaRemaining ?? base.handoffAtQuotaRemaining)! }
      : {}),
    ...((override.compactRequiresOperator ?? base.compactRequiresOperator) !== undefined
      ? { compactRequiresOperator: (override.compactRequiresOperator ?? base.compactRequiresOperator)! }
      : {}),
    ...((override.compactHandoffTurn ?? base.compactHandoffTurn) !== undefined
      ? { compactHandoffTurn: (override.compactHandoffTurn ?? base.compactHandoffTurn)! }
      : {}),
  }
}

/**
 * Resolve the effective policy from the override precedence chain.
 * Order (lowest → highest): global → harness → model → session.
 * Validates the final result and throws a clear error if the combined
 * policy is unsafe.
 */
export function resolveContextContinuityPolicy(
  globalDefault: ContextContinuityPolicy | undefined,
  harnessDefault: ContextContinuityPolicy | undefined,
  modelDefault: ContextContinuityPolicy | undefined,
  sessionOverride: ContextContinuityPolicy | undefined,
): ResolvedContextContinuityPolicy {
  let resolved = CONTEXT_CONTINUITY_DEFAULTS
  resolved = mergePolicyLayer(resolved, globalDefault)
  resolved = mergePolicyLayer(resolved, harnessDefault)
  resolved = mergePolicyLayer(resolved, modelDefault)
  resolved = mergePolicyLayer(resolved, sessionOverride)
  resolved.label = resolved.label ?? resolved.mode

  const validation = validateContextContinuityPolicy(resolved)
  if (!validation.ok) {
    throw new Error(`Invalid context continuity policy: ${validation.reason}`)
  }
  return resolved
}

/**
 * Compute context percentage from usage fields, returning null when unknown
 * — never a fabricated number the rail can act on.
 *
 * `contextSize === contextUsed` is treated as unknown too, not "100% full":
 * a window size this codebase never had (an adapter that reports its raw
 * token count as both fields because it has no real window figure — see
 * the `pi` adapter's historical bug, fixed in pi-events.ts `usageUpdate`)
 * is indistinguishable from a session that has genuinely filled its window
 * to the last token. Treating the ambiguous case as "cannot compute" is
 * the safe default: an adapter approaching a real 100% will already have
 * crossed every lower threshold (warn/compact/continue-fresh/hard-stop) on
 * the way there, since `contextUsed` grows toward — not straight to — the
 * window size.
 */
export function computeContextPct(
  contextSize: number | undefined,
  contextUsed: number | undefined,
): number | null {
  if (contextSize === undefined || contextSize <= 0) return null
  if (contextUsed === undefined || contextUsed < 0) return null
  if (contextUsed === contextSize) return null
  // Clamp to contextSize in the percentage; implausibly large values are
  // handled upstream by plausibleContextUsed, but we guard here too.
  const used = Math.min(contextUsed, contextSize)
  return Math.round((used / contextSize) * 100)
}

/** Map a percentage to the policy state without considering mode. */
export function contextContinuityStateForPct(
  pct: number,
  policy: ContextContinuityThresholds,
): Exclude<ContextContinuityState, "ok"> | "ok" {
  if (pct >= policy.hardStopAtPct) return "hard-stop"
  if (pct >= policy.continueFreshAtPct) return "continue-fresh"
  if (pct >= policy.compactAtPct) return "compact"
  if (pct >= policy.warnAtPct) return "warn"
  return "ok"
}

/** Determine the automatic next action for a state under a given mode. */
export function contextContinuityNextAction(
  state: ContextContinuityState,
  mode: ContextContinuityMode,
): ContextContinuityNextAction {
  switch (state) {
    case "ok":
      return "none"
    case "warn":
      return mode === "manual" ? "none" : "warn"
    case "compact":
      if (mode === "manual") return "none"
      if (mode === "ask") return "ask"
      return "compact"
    case "continue-fresh":
      if (mode === "manual") return "none"
      if (mode === "ask") return "ask"
      return "continue-fresh"
    case "hard-stop":
      // Mode-independent by design — see the `ContextContinuityMode` doc
      // comment: the floor is an unconditional safety net (the runtime
      // compacts / continues fresh / stops), not a nudge `manual` can silence.
      return "hard-stop"
  }
}

function stateSummary(pct: number | null, state: ContextContinuityState, policy: ResolvedContextContinuityPolicy): string {
  if (pct === null) return "Context window size unknown — continuity policy idle."
  switch (state) {
    case "ok":
      return `Context at ${pct}% — below warn threshold (${policy.warnAtPct}%).`
    case "warn":
      return `Context at ${pct}%: compaction is automatic at the token threshold.`
    case "compact":
      return `Context at ${pct}% — compact recommended (${policy.continueFreshAtPct}% continues fresh).`
    case "continue-fresh":
      return `Context at ${pct}% — fresh continuation recommended to avoid data loss.`
    case "hard-stop":
      return `Context at ${pct}% — at the floor: the runtime compacts automatically, then continues fresh if that is not enough.`
  }
}

/** Build the public status view for a session. */
export function computeContextContinuityStatus(
  sessionId: string,
  policy: ResolvedContextContinuityPolicy,
  contextSize: number | undefined,
  contextUsed: number | undefined,
): ContextContinuityStatus {
  const pct = computeContextPct(contextSize, contextUsed)
  const state = pct === null ? "ok" : contextContinuityStateForPct(pct, policy)
  const nextAction = contextContinuityNextAction(state, policy.mode)

  const thresholds = [
    policy.warnAtPct,
    policy.compactAtPct,
    policy.continueFreshAtPct,
    policy.hardStopAtPct,
  ]
  const nextThreshold = pct === null ? null : thresholds.find(t => t > pct) ?? null
  const nextThresholdDelta = pct === null || nextThreshold === null ? null : nextThreshold - pct

  const autoCompactAtTokens = clampAutoCompactTokens(policy.autoCompactAtTokens)
  return {
    sessionId,
    contextSize,
    contextUsed,
    contextPct: pct,
    policy,
    state,
    summary: stateSummary(pct, state, policy),
    nextAction,
    nextThresholdDelta,
    autoCompactAtTokens,
    autoCompactAboveThreshold:
      autoCompactAtTokens > 0 &&
      contextUsed !== undefined &&
      contextUsed >= autoCompactAtTokens,
  }
}

/** Whether a context percentage is currently at or past the hard stop. */
export function isContextContinuityHardStopped(
  pct: number | null,
  policy: ResolvedContextContinuityPolicy,
): boolean {
  return pct !== null && pct >= policy.hardStopAtPct
}
