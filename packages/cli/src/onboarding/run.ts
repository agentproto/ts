/**
 * Step runner: executes onboarding steps' `detect` sequentially and never
 * crashes the run — a throwing step becomes one `broken` check, a step that
 * overruns its timeout becomes one `warn` "not checked" check, and the rest
 * still run.
 */

import type { OnboardingStep, StepCheck, StepContext, StepReport } from "./types.js"

export const DEFAULT_STEP_TIMEOUT_MS = 5_000

export interface RunChecksOptions {
  /** Only run these step ids (empty/absent ⇒ all). */
  only?: readonly string[]
  /** Skip these step ids. */
  skip?: readonly string[]
  /** Per-step timeout unless the step sets its own. */
  timeoutMs?: number
}

class StepTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeoutError(`timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/** Steps selected by `only`/`skip`, in registry order. */
export function selectSteps(
  steps: readonly OnboardingStep[],
  opts: Pick<RunChecksOptions, "only" | "skip"> = {},
): OnboardingStep[] {
  const only = opts.only && opts.only.length > 0 ? new Set(opts.only) : null
  const skip = new Set(opts.skip ?? [])
  return steps.filter((s) => (only === null || only.has(s.id)) && !skip.has(s.id))
}

export async function runChecks(
  steps: readonly OnboardingStep[],
  ctx: StepContext,
  opts: RunChecksOptions = {},
): Promise<StepReport[]> {
  const reports: StepReport[] = []
  for (const step of selectSteps(steps, opts)) {
    const started = ctx.now()
    let checks: StepCheck[]
    try {
      checks = await withTimeout(
        step.detect(ctx),
        step.timeoutMs ?? opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      checks = [
        err instanceof StepTimeoutError
          ? { id: `${step.id}.timeout`, title: step.title, status: "warn", detail: `not checked: ${message}` }
          : { id: `${step.id}.error`, title: step.title, status: "broken", detail: message },
      ]
    }
    reports.push({
      id: step.id,
      title: step.title,
      required: step.required,
      checks,
      durationMs: Math.max(0, ctx.now() - started),
    })
  }
  return reports
}

export interface ReportSummary {
  ok: number
  warn: number
  missing: number
  broken: number
}

export function summarize(reports: readonly StepReport[]): ReportSummary {
  const summary: ReportSummary = { ok: 0, warn: 0, missing: 0, broken: 0 }
  for (const r of reports) {
    for (const c of r.checks) {
      if (c.status !== "skipped") summary[c.status] += 1
    }
  }
  return summary
}

/** A run fails iff a REQUIRED step has a `missing` or `broken` check.
 *  `warn` never fails. */
export function hasRequiredFailure(reports: readonly StepReport[]): boolean {
  return reports.some(
    (r) => r.required && r.checks.some((c) => c.status === "missing" || c.status === "broken"),
  )
}
