import type { RunStep } from "@agentproto/workflow-runtime"
import { WorkflowProjectionError } from "./errors.js"

const UNPROJECTABLE_REASON: Partial<Record<RunStep["kind"], string>> = {
  suspend:
    "a durable suspend/resume pair has no way back into a single AI SDK " +
    "tool call — there's no external channel this projection can use to " +
    "resume a run that's already returned control to the model.",
  approval:
    "there's no host-injected approve callback available at wrap time to " +
    "decide it, and a mid-run human approval gate doesn't fit a single " +
    "atomic tool invocation either.",
  pipeline:
    "PipelineStep is a @agentproto/workflow-runtime-only fan-out kind not " +
    "covered by the WORKFLOW.md → AI SDK design spec this package implements.",
}

/**
 * Walk every step (recursing into every composite kind's children) and
 * throw {@link WorkflowProjectionError} on the first unmappable kind. Called
 * once, eagerly, when {@link toAiSdkWorkflowTool} builds the tool — not
 * deferred to whenever the model happens to reach that step at run time.
 */
export function assertProjectable(steps: readonly RunStep[], path = ""): void {
  for (const step of steps) {
    const reason = UNPROJECTABLE_REASON[step.kind]
    if (reason) {
      throw new WorkflowProjectionError(
        `step '${path}${step.id}' (kind '${step.kind}') is not projectable to AI SDK — ${reason}`,
      )
    }
    const nextPath = `${path}${step.id}.`
    switch (step.kind) {
      case "group":
        assertProjectable(step.steps, nextPath)
        break
      case "branch":
        assertProjectable(step.then, nextPath)
        if (step.otherwise) assertProjectable(step.otherwise, nextPath)
        break
      case "parallel":
        for (const branch of step.branches) assertProjectable(branch.steps, `${nextPath}${branch.id}.`)
        break
      case "loop":
        assertProjectable(step.body, nextPath)
        break
      case "map": {
        const shape = step.body(undefined, 0, { input: undefined, steps: {} })
        assertProjectable([shape], nextPath)
        break
      }
      case "subworkflow":
        assertProjectable(step.workflow.steps, nextPath)
        break
      default:
        break
    }
  }
}
