import type { RunStep } from "@agentproto/workflow-runtime"
import { WorkflowProjectionError } from "./errors.js"

const UNPROJECTABLE_REASON: Partial<Record<RunStep["kind"], string>> = {
  suspend:
    "Mastra has no equivalent this projection wires up yet — a durable " +
    "suspend/resume pair needs a host-level resume channel this projector " +
    "doesn't have access to at build time. Hand-author the Mastra `.suspend()` " +
    "step directly if you need this.",
  approval:
    "there's no host-injected approve callback available at Mastra-build " +
    "time to decide it — the engine's own ApprovalStep needs a live " +
    "`RunWorkflowArgs.approve` hook, which only exists per-run, not per-projection.",
  pipeline:
    "PipelineStep is a @agentproto/workflow-runtime-only fan-out kind not " +
    "covered by the WORKFLOW.md → Mastra design spec this package implements " +
    "— it is NOT silently downgraded to `map` semantics it doesn't have.",
}

/**
 * Walk every step (recursing into every composite kind's children) and
 * throw {@link WorkflowProjectionError} on the first unmappable kind. Called
 * BEFORE {@link toMastraWorkflow} builds anything, so a workflow that can't
 * be projected fails at wrap time, not partway through a run.
 */
export function assertProjectable(steps: readonly RunStep[], path = ""): void {
  for (const step of steps) {
    const reason = UNPROJECTABLE_REASON[step.kind]
    if (reason) {
      throw new WorkflowProjectionError(
        `step '${path}${step.id}' (kind '${step.kind}') is not projectable to Mastra — ${reason}`,
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
        // The body is a function of (item, index, bindings); compiler-produced
        // bodies ignore all three and return the same compiled step regardless
        // (see compile-workflow.ts's `map` case), so a placeholder call is
        // enough to inspect its shape without actually running anything.
        const shape = step.body(undefined, 0, { input: undefined, steps: {} })
        assertProjectable([shape], nextPath)
        break
      }
      case "subworkflow":
        assertProjectable(step.workflow.steps, nextPath)
        break
      default:
        break // tool / transform / agent: no children to walk
    }
  }
}
