/**
 * Compile a review binding into an ordinary AIP-15 `WorkflowHandle` — the
 * existing workflow machinery (`@agentproto/workflow-runtime`'s
 * `compileWorkflow` + `runWorkflow`) executes it; there is no review engine.
 *
 * Shape of the compiled workflow, in document order:
 *
 *   prepare-<id>…  `kind: "gate"`      one per `prepare` entry, sequential —
 *                                      `sh -c <run>` through the engine's own
 *                                      gate runner. They run BEFORE the range
 *                                      is frozen (a prepare step may commit).
 *                                      A failing prepare step fails the run.
 *   freeze         `kind: "transform"` asks the host to freeze the range
 *                                      (resolve head AFTER prepare); binds
 *                                      the {@link ReviewTarget}.
 *   lanes          `kind: "parallel"`  one branch per selected check; each
 *                                      branch is a single lane step that
 *                                      calls the host's lane executor and
 *                                      ALWAYS resolves to a {@link LaneResult}
 *                                      (a lane that throws becomes `skipped`,
 *                                      so one lane can't abort its siblings).
 *   verdict        `kind: "transform"` the fan-in: folds the lane results
 *                                      under the binding's quorum.
 *
 * `result: "$steps.verdict"` makes the run's output the {@link ReviewOutcome}.
 *
 * Why lanes are host-executor transforms and not declarative `gate` / `agent`
 * steps: a failing `gate` step THROWS (and a `parallel` step is
 * `Promise.all`), so a red lane would abort the whole review and lose every
 * sibling lane's result; the engine's gate runner also drops the timed-out
 * signal a lane needs to report `timeout` instead of `fail`. The lane
 * executor seam keeps per-lane status/timeout/cancel semantics while the
 * engine still owns sequencing, the parallel fan-out, and the fan-in binding.
 * `transform` is the engine's documented pass-through kind for host-built
 * steps (see `compile-workflow.ts`).
 */

import { defineWorkflow, type WorkflowDefinition, type WorkflowHandle } from "@agentproto/workflow"
import type { AgentLaneReport } from "./agent-lane.js"
import {
  getCheck,
  resolveBinding,
  type AgentCheck,
  type CommandCheck,
  type ReviewBinding,
  type ReviewCheck,
  type ReviewManifest,
} from "./manifest.js"
import { listPlaceholders, substitutePlaceholders } from "./placeholders.js"
import type { Finding, LaneResult, ReviewTarget, Verdict } from "./types.js"
import { agentLaneStatus, foldVerdict } from "./verdict.js"

/** One lane handed to the host's executor. Command lanes carry their `run`
 *  line with placeholders already substituted against the frozen range. */
export type LaneInvocation =
  | { kind: "command"; check: CommandCheck; command: string; target: ReviewTarget }
  | { kind: "agent"; check: AgentCheck; target: ReviewTarget }

/** What the host's executor reports for one lane. The lane's STATUS is
 *  derived from this by {@link toLaneResult} — never chosen by the host. */
export type LaneOutcome =
  /** A command lane's process exited. `output` is a (tail of) combined
   *  stdout/stderr, surfaced as the finding detail on a non-zero exit. */
  | { outcome: "exited"; exitCode: number; output?: string }
  /** An agent lane's reviewer wrote a valid verdict file. */
  | { outcome: "reported"; report: AgentLaneReport; sessionId?: string; preset?: string }
  /** The lane exceeded its `timeoutMs` and was stopped. */
  | { outcome: "timeout"; error: string; sessionId?: string; preset?: string; output?: string }
  /** The lane could not produce a result (spawn failed, no verdict file,
   *  cancelled, …). */
  | { outcome: "skipped"; error: string; sessionId?: string; preset?: string }

/** The host seam that actually runs a lane. The daemon wires a real one
 *  (subprocess for command lanes, a child reviewer session for agent lanes);
 *  tests wire a fake. */
export interface ReviewLaneExecutor {
  runLane(lane: LaneInvocation, signal?: AbortSignal): Promise<LaneOutcome>
}

export interface CompileReviewOptions {
  /** Binding name. Omitted ⇒ the sole binding, or `default`. */
  binding?: string
  /** Host-provided placeholder values (e.g. `changed`). `base` and `head`
   *  are bound by the compiler from the frozen range for lanes. */
  vars?: Readonly<Record<string, string>>
  /** Freeze the range — called once, after the prepare phase. */
  freeze: () => Promise<ReviewTarget>
  executor: ReviewLaneExecutor
  /** Cancels lanes that haven't started and is forwarded to running ones. */
  signal?: AbortSignal
  /** Observe each lane as it settles (progress reporting). */
  onLaneSettled?: (lane: LaneResult) => void
}

/** The compiled workflow's output (`$steps.verdict`). */
export interface ReviewOutcome {
  target: ReviewTarget
  lanes: LaneResult[]
  verdict: Verdict
}

export interface CompiledReview {
  manifest: ReviewManifest
  binding: ReviewBinding
  /** Effects-capable checks run before the freeze, in order. */
  prepare: CommandCheck[]
  /** Attesting lanes, in binding order. */
  lanes: ReviewCheck[]
  /** The runnable workflow — feed it to `compileWorkflow` + `runWorkflow`. */
  workflow: WorkflowHandle
}

export class ReviewCompileError extends Error {
  constructor(message: string) {
    super(`compileReview: ${message}`)
    this.name = "ReviewCompileError"
  }
}

/** Placeholders the compiler binds for lanes from the frozen range. */
export const RANGE_PLACEHOLDERS = ["base", "head"] as const

/** Max chars of command output kept as a failing lane's finding detail. */
const OUTPUT_TAIL_CHARS = 4_000

const tail = (s: string | undefined): string =>
  s === undefined ? "" : s.length > OUTPUT_TAIL_CHARS ? `…${s.slice(-OUTPUT_TAIL_CHARS)}` : s

/** Turn an executor outcome into the lane's result. Pure; the one place lane
 *  status is decided. */
export function toLaneResult(check: ReviewCheck, outcome: LaneOutcome, durationMs: number): LaneResult {
  const base = { id: check.id, kind: check.kind, blocking: check.blocking, durationMs }
  const sessionFields = (o: { sessionId?: string; preset?: string }) => ({
    ...(o.sessionId !== undefined ? { sessionId: o.sessionId } : {}),
    ...(o.preset !== undefined ? { preset: o.preset } : {}),
  })
  switch (outcome.outcome) {
    case "exited": {
      if (check.kind !== "command") {
        return { ...base, status: "skipped", findings: [], error: "internal: agent lane reported a process exit" }
      }
      const findings: Finding[] =
        outcome.exitCode === 0
          ? []
          : [
              {
                severity: "high",
                title: `'${check.id}' exited with code ${outcome.exitCode}`,
                detail: tail(outcome.output),
              },
            ]
      return { ...base, status: outcome.exitCode === 0 ? "pass" : "fail", findings, exitCode: outcome.exitCode }
    }
    case "reported": {
      if (check.kind !== "agent") {
        return { ...base, status: "skipped", findings: [], error: "internal: command lane reported an agent verdict" }
      }
      return {
        ...base,
        status: agentLaneStatus(outcome.report.findings, check.blockOn),
        findings: outcome.report.findings,
        ...(outcome.report.summary !== undefined ? { summary: outcome.report.summary } : {}),
        ...sessionFields(outcome),
      }
    }
    case "timeout":
      return {
        ...base,
        status: "timeout",
        findings: [],
        error: outcome.output ? `${outcome.error}\n${tail(outcome.output)}` : outcome.error,
        ...sessionFields(outcome),
      }
    case "skipped":
      return { ...base, status: "skipped", findings: [], error: outcome.error, ...sessionFields(outcome) }
  }
}

/** Minimal structural twin of `@agentproto/workflow-runtime`'s `Bindings` —
 *  kept local so this pure package doesn't depend on the engine. */
interface RunBindings {
  readonly steps: Readonly<Record<string, unknown>>
}

/** Workflow ids are `^[a-z][a-z0-9-]*[a-z0-9]$`, 2–64 chars. */
function workflowIdFor(reviewId: string, binding: string): string {
  return `review-${reviewId}-${binding}`.slice(0, 64).replace(/-+$/, "")
}

function assertPlaceholders(check: CommandCheck, bound: ReadonlySet<string>, phase: "prepare" | "lane"): void {
  for (const name of listPlaceholders(check.run)) {
    if (bound.has(name)) continue
    if (phase === "prepare" && name === "head") {
      throw new ReviewCompileError(
        `prepare check '${check.id}' uses {head}, which is not bound yet — prepare runs BEFORE the range is frozen`,
      )
    }
    throw new ReviewCompileError(
      `check '${check.id}' uses placeholder {${name}}, which is not bound — bound: ${[...bound]
        .map((n) => `{${n}}`)
        .join(", ")}`,
    )
  }
}

async function runLane(
  check: ReviewCheck,
  target: ReviewTarget,
  vars: Readonly<Record<string, string>>,
  opts: CompileReviewOptions,
): Promise<LaneResult> {
  const started = Date.now()
  let outcome: LaneOutcome
  if (opts.signal?.aborted) {
    outcome = { outcome: "skipped", error: "review cancelled before this lane started" }
  } else {
    try {
      const invocation: LaneInvocation =
        check.kind === "command"
          ? {
              kind: "command",
              check,
              command: substitutePlaceholders(
                check.run,
                { ...vars, base: target.baseSha, head: target.headSha },
                `check '${check.id}'`,
              ),
              target,
            }
          : { kind: "agent", check, target }
      outcome = await opts.executor.runLane(invocation, opts.signal)
    } catch (err) {
      outcome = { outcome: "skipped", error: err instanceof Error ? err.message : String(err) }
    }
  }
  const result = toLaneResult(check, outcome, Date.now() - started)
  opts.onLaneSettled?.(result)
  return result
}

/** Compile `manifest`'s binding into a runnable workflow. Throws
 *  {@link ReviewCompileError} (or the manifest's own error for an unknown
 *  binding) — every failure is at compile time, before anything runs. */
export function compileReview(manifest: ReviewManifest, opts: CompileReviewOptions): CompiledReview {
  const binding = resolveBinding(manifest, opts.binding)
  const vars = opts.vars ?? {}
  const prepare = binding.prepare.map((id) => {
    const check = getCheck(manifest, id)
    if (check.kind !== "command") {
      throw new ReviewCompileError(`prepare check '${id}' must be a command check`)
    }
    return check
  })
  const lanes = binding.checks.map((id) => getCheck(manifest, id))

  const prepareBound = new Set(Object.keys(vars))
  const laneBound = new Set([...Object.keys(vars), ...RANGE_PLACEHOLDERS])
  for (const check of prepare) assertPlaceholders(check, prepareBound, "prepare")
  for (const check of lanes) if (check.kind === "command") assertPlaceholders(check, laneBound, "lane")

  const prepareSteps = prepare.map((check) => ({
    id: `prepare-${check.id}`,
    kind: "gate",
    command: "sh",
    args: ["-c", substitutePlaceholders(check.run, vars, `prepare check '${check.id}'`)],
    ...(check.cwd !== undefined ? { cwd: check.cwd } : {}),
    timeout_ms: check.timeoutMs,
  }))

  const freezeStep = {
    id: "freeze",
    kind: "transform",
    compute: () => opts.freeze(),
  }

  const lanesStep = {
    id: "lanes",
    kind: "parallel",
    branches: lanes.map((check) => ({
      id: check.id,
      steps: [
        {
          id: `lane-${check.id}`,
          kind: "transform",
          compute: (b: RunBindings) => runLane(check, b.steps.freeze as ReviewTarget, vars, opts),
        },
      ],
    })),
  }

  const verdictStep = {
    id: "verdict",
    kind: "transform",
    compute: (b: RunBindings): ReviewOutcome => {
      const byLane = b.steps.lanes as Record<string, LaneResult>
      const results = lanes.map((c) => byLane[c.id]!)
      return {
        target: b.steps.freeze as ReviewTarget,
        lanes: results,
        verdict: foldVerdict(results, binding.quorum),
      }
    },
  }

  const workflow = defineWorkflow({
    id: workflowIdFor(manifest.id, binding.name),
    name: `review ${manifest.id} (${binding.name})`,
    description:
      manifest.description ??
      `Review '${manifest.id}', binding '${binding.name}': ${prepare.length} prepare step(s), ${lanes.length} lane(s).`,
    version: "1.0.0",
    inputs: {},
    outputs: {},
    // `transform` steps are host-built runtime steps the engine passes
    // through unchanged; the declarative `Step` union doesn't model them.
    steps: [...prepareSteps, freezeStep, lanesStep, verdictStep] as unknown as WorkflowDefinition["steps"],
    result: "$steps.verdict",
  })

  return { manifest, binding, prepare, lanes, workflow }
}
