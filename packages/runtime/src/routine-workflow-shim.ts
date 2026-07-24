/**
 * Deprecated `routine_*` verbs/routes, lowered onto `workflowRunner`.
 *
 * The imperative RoutineRunner engine (`routine-runner.ts`) is gone — see
 * PLAN.md "Phase B — fold the imperative RoutineRunner into AIP-15
 * workflow". A "routine" sequential run is now an AIP-15 workflow of
 * single-step stages, driven by the same `workflowRunner` `workflow_*`
 * uses. This module is the thin shim that keeps the five `routine_*` MCP
 * verbs + `/routines/*` run routes alive as DEPRECATED aliases — removal is
 * tracked as a follow-up PR after a deprecation window.
 *
 * `waitFor` (external-session fan-in) has NO workflow equivalent and had no
 * in-repo consumer — `start()` rejects it with a clear error instead of
 * silently dropping it.
 */

import type { WorkflowRun, WorkflowRunner, WorkflowStage, WorkflowStep } from "./workflow-runner.js"
import type { RoutineStep, RoutineStepState } from "./step-run-types.js"

// ── Public types (preserved from the deleted routine-runner.ts) ────────

export type RoutineRunStatus =
  | "idle"
  | "running"
  | "awaiting-input"
  | "done"
  | "failed"
  | "cancelled"

export interface RoutineRun {
  runId: string
  routineId: string
  status: RoutineRunStatus
  startedAt: string
  endedAt?: string
  steps: RoutineStepState[]
  notifyUrl?: string
  error?: string
  result?: { sessionIds: string[] }
}

export interface RoutineRunner {
  start(input: {
    routineId: string
    steps: RoutineStep[]
    workspaceSlug?: string
    cwd?: string
    notifyUrl?: string
  }): Promise<RoutineRun>

  status(runId: string): RoutineRun | undefined
  list(): RoutineRun[]

  /**
   * Provide an external answer to a step stuck in "escalate" awaiting-input.
   */
  resolve(runId: string, stepIndex: number, response: string): void

  cancel(runId: string): void
}

// ── Translation: WorkflowRun → RoutineRun (flatten single-step stages) ──

/** A shim-built run always has exactly one step per stage — flatten back to
 *  the flat `steps[]` shape `routine_status`/`routine_list` callers parse. */
function toRoutineRun(run: WorkflowRun): RoutineRun {
  const steps = run.stages.flatMap(stage => stage.steps).map((step, index) => ({ ...step, index }))
  return {
    runId: run.runId,
    routineId: run.workflowId,
    status: run.status,
    startedAt: run.startedAt,
    steps,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(run.notifyUrl !== undefined ? { notifyUrl: run.notifyUrl } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.result !== undefined ? { result: run.result } : {}),
  }
}

export function createRoutineWorkflowShim(opts: { workflowRunner: WorkflowRunner }): RoutineRunner {
  const { workflowRunner } = opts

  return {
    start: async input => {
      const waitForStep = input.steps.find(s => (s.waitFor?.length ?? 0) > 0)
      if (waitForStep) {
        throw new Error(
          `routine_start: 'waitFor' (external-session fan-in, step "${waitForStep.label}") has been ` +
            "removed along with the RoutineRunner engine — express fan-in as parallel " +
            "workflow stages via workflow_start instead.",
        )
      }

      // Single-step-per-stage sequential workflow. A step with no `adapter`
      // reused RoutineRunner's implicit "current run's last spawned
      // session" — expressed here as an explicit `sessionRef` to the
      // nearest prior step that spawned one.
      let lastAdapterLabel: string | undefined
      const stages: WorkflowStage[] = input.steps.map(s => {
        const step: WorkflowStep = {
          label: s.label,
          ...(s.prompt !== undefined ? { prompt: s.prompt } : {}),
          ...(s.policy !== undefined ? { policy: s.policy } : {}),
        }
        if (s.adapter !== undefined) {
          step.adapter = s.adapter
          lastAdapterLabel = s.label
        } else if (lastAdapterLabel !== undefined) {
          step.sessionRef = lastAdapterLabel
        }
        return { steps: [step] }
      })

      const run = await workflowRunner.start({
        workflowId: input.routineId,
        stages,
        ...(input.workspaceSlug !== undefined ? { workspaceSlug: input.workspaceSlug } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.notifyUrl !== undefined ? { notifyUrl: input.notifyUrl } : {}),
      })
      return toRoutineRun(run)
    },

    status: runId => {
      const run = workflowRunner.status(runId)
      return run ? toRoutineRun(run) : undefined
    },

    list: () => workflowRunner.list().map(toRoutineRun),

    // Single-step-per-stage by construction: stageIndex === stepIndex, and
    // the step-within-stage index is always 0.
    resolve: (runId, stepIndex, response) => {
      workflowRunner.resolve(runId, stepIndex, 0, response)
    },

    cancel: runId => workflowRunner.cancel(runId),
  }
}
