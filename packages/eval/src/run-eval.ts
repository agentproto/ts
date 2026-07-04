/**
 * `runEval` — the eval harness.
 *
 * The thesis this file proves: **an eval is a workflow that runs a target then
 * scores its output with scorer-tools, reporting through the telemetry port.**
 *
 * For each case we build a {@link RuntimeWorkflow} that composes
 *   target → one scorer `tool` step per binding → a per-case aggregate transform
 * and execute it with `runWorkflow` (AIP-15). The target's structured output is
 * the input selector for every scorer step — that is where composable tool I/O
 * is demonstrated. `runEval` then aggregates across cases and emits
 * {@link EvalEvent}s through an injected `Telemetry<EvalEvent>` sink.
 *
 * The `target` is a plain async function here (not required to be a tool); a
 * tool/agent target is a documented follow-up.
 */

import { runWorkflow, type RuntimeWorkflow } from "@agentproto/workflow-runtime"
import type { Telemetry } from "@agentproto/telemetry"
import type { DriverHandle } from "@agentproto/driver"
import type { ToolHandle } from "@agentproto/tool"
import type { Score } from "./score.js"
import type { JsonValue } from "./json.js"
import type { EvalEvent } from "./events.js"

/** One case: an input for the target and an optional expected reference. */
export interface EvalCase<I> {
  readonly id: string
  readonly input: I
  /** Optional reference value, modelled as JSON (never `unknown`/`any`). */
  readonly expected?: JsonValue
}

/** Context handed to a binding's `mapInput` when scoring one case's output. */
export interface ScorerInputContext<A> {
  readonly output: A
  readonly expected?: JsonValue
}

/**
 * One scorer applied to the target output. Generic over the target output type
 * `A` and the scorer's own input type `S` (captured when the binding is
 * authored). {@link bindScorer} erases `S` so heterogeneous scorers coexist in
 * one `EvalSuite.scorers` array without an `any`.
 */
export interface ScorerBinding<A, S = JsonValue> {
  /** Label for this binding, e.g. "exact". */
  readonly id: string
  /** The scorer TOOL contract — its `outputSchema` is the shared {@link Score}. */
  readonly tool: ToolHandle<S, Score>
  /** The DRIVER that implements the scorer tool. */
  readonly driver: DriverHandle
  /** Derive the scorer's input from the target's output (+ optional expected). */
  readonly mapInput: (ctx: ScorerInputContext<A>) => S
}

/**
 * The uniform, `S`-erased view of a binding stored in a suite. It exposes the
 * authored `id` plus a closure that runs the scorer for a given case output —
 * the existential box that lets a suite hold scorers with different input
 * types with no `any` at the collection boundary.
 */
export interface BoundScorer<A> {
  readonly id: string
  /** Build the AIP-15 tool step that scores one case's output. */
  toStep(stepId: string, output: A, expected?: JsonValue): RuntimeWorkflow["steps"][number]
}

/**
 * Box a typed {@link ScorerBinding} into a {@link BoundScorer}, capturing the
 * scorer input type `S` inside the closure so the outer type is `S`-free.
 */
export function bindScorer<A, S>(binding: ScorerBinding<A, S>): BoundScorer<A> {
  return {
    id: binding.id,
    toStep(stepId, output, expected) {
      return {
        kind: "tool",
        id: stepId,
        tool: binding.tool,
        candidates: [binding.driver],
        input: () => binding.mapInput({ output, expected }),
      }
    },
  }
}

export interface EvalSuite<A> {
  readonly id: string
  readonly cases: readonly EvalCase<unknown>[]
  readonly scorers: readonly BoundScorer<A>[]
}

/** One scorer's outcome on one case. */
export interface CaseScore {
  readonly scorerId: string
  readonly score: Score
}

/** The per-case rollup carried in the final report. */
export interface CaseReport {
  readonly caseId: string
  readonly passed: boolean
  readonly scores: readonly CaseScore[]
}

export interface EvalReport {
  readonly runId: string
  readonly suiteId: string
  readonly total: number
  readonly passedCount: number
  /** Mean of every scorer value across every case (0 when there are none). */
  readonly meanValue: number
  readonly cases: readonly CaseReport[]
}

export interface RunEvalOptions<I, A> {
  /** Produce the target output for a case input. */
  readonly target: (input: I) => Promise<A>
  /** Sink for {@link EvalEvent}s. Defaults to a no-op. */
  readonly telemetry?: Telemetry<EvalEvent>
  /** Correlation id for this run. Defaults to a deterministic suite-based id. */
  readonly runId?: string
}

/** A suite whose cases share the target input type `I`. */
export interface TypedEvalSuite<I, A> extends EvalSuite<A> {
  readonly cases: readonly EvalCase<I>[]
}

/** Per-process counter so a default runId is deterministic within a process. */
let runCounter = 0

function defaultRunId(suiteId: string): string {
  runCounter += 1
  return `${suiteId}#${runCounter}`
}

/** The per-case aggregate: which scorers ran and whether all passed. */
interface CaseAggregate {
  readonly scores: readonly CaseScore[]
  readonly passed: boolean
}

/** Narrow a step-binding value to a {@link Score} without a cast. */
function asScore(value: unknown): Score {
  if (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    "passed" in value &&
    "label" in value
  ) {
    const v: unknown = value.value
    const passed: unknown = value.passed
    const label: unknown = value.label
    const rationale: unknown = "rationale" in value ? value.rationale : undefined
    if (
      typeof v === "number" &&
      typeof passed === "boolean" &&
      typeof label === "string" &&
      (rationale === undefined || typeof rationale === "string")
    ) {
      return { value: v, passed, label, rationale }
    }
  }
  throw new Error("scorer step did not produce a valid Score")
}

/**
 * Run every case in the suite, scoring each with all bound scorers, and return
 * the aggregated {@link EvalReport}. Emits `eval.started` … `eval.finished`.
 */
export async function runEval<I, A>(
  suite: TypedEvalSuite<I, A>,
  opts: RunEvalOptions<I, A>,
): Promise<EvalReport> {
  const telemetry = opts.telemetry
  const runId = opts.runId ?? defaultRunId(suite.id)
  const start = Date.now()

  telemetry?.emit({
    kind: "eval.started",
    runId,
    at: new Date().toISOString(),
    suiteId: suite.id,
    caseCount: suite.cases.length,
    scorerCount: suite.scorers.length,
  })

  const caseReports: CaseReport[] = []
  let valueSum = 0
  let valueCount = 0

  for (const evalCase of suite.cases) {
    telemetry?.emit({
      kind: "eval.case.started",
      runId,
      at: new Date().toISOString(),
      caseId: evalCase.id,
    })

    const aggregate = await runCase(suite, evalCase, opts.target)

    for (const cs of aggregate.scores) {
      valueSum += cs.score.value
      valueCount += 1
      telemetry?.emit({
        kind: "eval.case.scored",
        runId,
        at: new Date().toISOString(),
        caseId: evalCase.id,
        scorerId: cs.scorerId,
        value: cs.score.value,
        passed: cs.score.passed,
      })
    }

    telemetry?.emit({
      kind: "eval.case.finished",
      runId,
      at: new Date().toISOString(),
      caseId: evalCase.id,
      passed: aggregate.passed,
    })

    caseReports.push({
      caseId: evalCase.id,
      passed: aggregate.passed,
      scores: aggregate.scores,
    })
  }

  const passedCount = caseReports.filter((c) => c.passed).length
  const meanValue = valueCount === 0 ? 0 : valueSum / valueCount

  const report: EvalReport = {
    runId,
    suiteId: suite.id,
    total: suite.cases.length,
    passedCount,
    meanValue,
    cases: caseReports,
  }

  telemetry?.emit({
    kind: "eval.finished",
    runId,
    at: new Date().toISOString(),
    suiteId: suite.id,
    total: report.total,
    passedCount,
    meanValue,
    durationMs: Date.now() - start,
  })

  return report
}

/**
 * Build and run the per-case workflow: `target` → one scorer tool-step per
 * binding → an aggregate transform, then read the aggregate off the run output.
 */
async function runCase<I, A>(
  suite: EvalSuite<A>,
  evalCase: EvalCase<I>,
  target: (input: I) => Promise<A>,
): Promise<CaseAggregate> {
  const output = await target(evalCase.input)
  const scorerStepIds = suite.scorers.map((_, i) => `score_${i}`)

  const workflow: RuntimeWorkflow = {
    id: `${suite.id}:${evalCase.id}`,
    steps: [
      ...suite.scorers.map((scorer, i) =>
        scorer.toStep(scorerStepIds[i]!, output, evalCase.expected),
      ),
      {
        kind: "transform",
        id: "aggregate",
        compute: (b): CaseAggregate => {
          const scores: CaseScore[] = suite.scorers.map((scorer, i) => ({
            scorerId: scorer.id,
            score: asScore(b.steps[scorerStepIds[i]!]),
          }))
          return { scores, passed: scores.every((s) => s.score.passed) }
        },
      },
    ],
    output: (b) => b.steps.aggregate,
  }

  const { output: runOutput } = await runWorkflow({ workflow })
  return toCaseAggregate(runOutput)
}

/** Narrow the workflow output to a {@link CaseAggregate} without a cast. */
function toCaseAggregate(value: unknown): CaseAggregate {
  if (
    typeof value === "object" &&
    value !== null &&
    "scores" in value &&
    "passed" in value &&
    Array.isArray(value.scores) &&
    typeof value.passed === "boolean"
  ) {
    const scores = value.scores.map((entry: unknown) => {
      if (
        typeof entry === "object" &&
        entry !== null &&
        "scorerId" in entry &&
        "score" in entry &&
        typeof entry.scorerId === "string"
      ) {
        return { scorerId: entry.scorerId, score: asScore(entry.score) }
      }
      throw new Error("invalid CaseScore in aggregate")
    })
    return { scores, passed: value.passed }
  }
  throw new Error("workflow did not produce a CaseAggregate")
}
