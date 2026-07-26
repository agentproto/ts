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
  /** Optional display label for UIs. */
  label?: string
}

/**
 * Fully-resolved, validated policy. This is the shape stored on a session
 * descriptor and returned by status queries.
 */
export interface ResolvedContextContinuityPolicy
  extends ContextContinuityThresholds,
    Required<ContextContinuityCheckpointSections> {
  mode: ContextContinuityMode
  /** Effective label (falls back to mode when absent). */
  label: string
}

export const CONTEXT_CONTINUITY_DEFAULTS: ResolvedContextContinuityPolicy = {
  mode: "ask",
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

/** Compute context percentage from usage fields, returning null when unknown. */
export function computeContextPct(
  contextSize: number | undefined,
  contextUsed: number | undefined,
): number | null {
  if (contextSize === undefined || contextSize <= 0) return null
  if (contextUsed === undefined || contextUsed < 0) return null
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
      return "hard-stop"
  }
}

function stateSummary(pct: number | null, state: ContextContinuityState, policy: ResolvedContextContinuityPolicy): string {
  if (pct === null) return "Context window size unknown — continuity policy idle."
  switch (state) {
    case "ok":
      return `Context at ${pct}% — below warn threshold (${policy.warnAtPct}%).`
    case "warn":
      return `Context at ${pct}% — consider compacting soon (${policy.compactAtPct}% auto).`
    case "compact":
      return `Context at ${pct}% — compact recommended (${policy.continueFreshAtPct}% continues fresh).`
    case "continue-fresh":
      return `Context at ${pct}% — fresh continuation recommended to avoid data loss.`
    case "hard-stop":
      return `Context at ${pct}% — hard stop. Continue via fresh continuation.`
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
  }
}

/** Whether a context percentage is currently at or past the hard stop. */
export function isContextContinuityHardStopped(
  pct: number | null,
  policy: ResolvedContextContinuityPolicy,
): boolean {
  return pct !== null && pct >= policy.hardStopAtPct
}
