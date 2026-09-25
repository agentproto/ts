import type { RunStep } from "@agentproto/workflow-runtime"
import { WorkflowProjectionError } from "./errors.js"

/** Unprojectable everywhere — top-level or nested, no exception. */
const ALWAYS_UNPROJECTABLE_REASON: Partial<Record<RunStep["kind"], string>> = {
  pipeline:
    "PipelineStep is a @agentproto/workflow-runtime-only fan-out kind not " +
    "covered by the WORKFLOW.md → Mastra design spec this package implements " +
    "— it is NOT silently downgraded to `map` semantics it doesn't have.",
  gate:
    "GateStep's real executor (run-workflow.ts's execGateStep) resolves " +
    "`$input|$item|$steps.<id>` ref-string args/cwd and drives its onFail " +
    "reprompt through the same private machinery — none of it is a public " +
    "seam this package can reuse, and re-implementing that resolution grammar " +
    "here would silently drift from the canonical semantics rather than run " +
    "the SAME gate a daemon run would. Not faked.",
}

/**
 * Unprojectable ONLY when nested inside a branch/parallel/loop/map/group
 * (i.e. reachable only through the local step-walker, not a real Mastra
 * step). A DIRECT top-level child of the workflow gets its own `createStep`
 * and so a real Mastra `suspend`/`resume` pair — see `suspendWrapper` /
 * `approvalWrapper` in `index.ts`. Nested, there is no per-step suspend
 * boundary to attach to: the local walker calling `params.suspend()` from
 * inside an ENCLOSING opaque step's `execute` would suspend the wrong step.
 */
const NESTED_ONLY_UNPROJECTABLE_REASON: Partial<Record<RunStep["kind"], string>> = {
  suspend:
    "nested inside a branch/parallel/loop/map/group, a SuspendStep runs " +
    "through the local step-walker, which has no Mastra step of its own to " +
    "call `suspend()` from — only a step that is a direct top-level child of " +
    "the workflow gets native Mastra suspend/resume.",
  approval:
    "nested inside a branch/parallel/loop/map/group, an ApprovalStep runs " +
    "through the local step-walker, which has no Mastra step of its own to " +
    "call `suspend()` from — only a step that is a direct top-level child of " +
    "the workflow gets native Mastra suspend/resume.",
}

/**
 * Walk every step (recursing into every composite kind's children) and
 * throw {@link WorkflowProjectionError} on the first unmappable kind. Called
 * BEFORE {@link toMastraWorkflow} builds anything, so a workflow that can't
 * be projected fails at wrap time, not partway through a run.
 */
export function assertProjectable(steps: readonly RunStep[], path = ""): void {
  for (const step of steps) {
    const reason =
      ALWAYS_UNPROJECTABLE_REASON[step.kind] ?? (path !== "" ? NESTED_ONLY_UNPROJECTABLE_REASON[step.kind] : undefined)
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
