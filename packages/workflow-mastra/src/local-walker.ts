/**
 * A small local step-walker used ONLY for what's inside a Mastra
 * combinator's single-step slot (a `.branch()` arm, a `.parallel()` branch,
 * a `.foreach()`/`.dowhile()` body, a `group`'s children). Mastra's own
 * combinators need exactly one `Step` per slot; when that slot holds more
 * than one engine step, this walker runs them in-process instead of
 * expressing each one as its own Mastra primitive.
 *
 * It mirrors `@agentproto/workflow-runtime`'s own (unexported) `execStep` —
 * same shared, mutable `steps` accumulator, same selector-evaluation order —
 * for one reason `runWorkflow`'s public entrypoint can't provide: `map`'s
 * `$item`/`$index` bindings are only ever produced by the engine's own
 * per-iteration loop, and `RunWorkflowArgs.input` has no seam for injecting
 * them into an isolated sub-run. Reusing the compiled step's own selectors
 * directly, in-process, is what keeps `$item`/`$index` (and `$steps.<id>`
 * for anything already bound in the SAME Mastra run) resolving correctly.
 */

import { runTool } from "@agentproto/driver"
import {
  runWorkflow,
  type AgentSessionHost,
  type Bindings,
  type RunStep,
} from "@agentproto/workflow-runtime"
import { WorkflowProjectionError } from "./errors.js"

export interface LocalWalkerCtx {
  agents?: AgentSessionHost
  cwd?: string
  workspaceSlug?: string
  signal?: AbortSignal
}

/** Run an ordered list of steps, folding each output into the shared `acc` bag. */
export async function runLocalSteps(
  steps: readonly RunStep[],
  bindings: Bindings,
  acc: Record<string, unknown>,
  ctx: LocalWalkerCtx,
): Promise<unknown> {
  let last: unknown
  for (const step of steps) {
    last = await runLocalStep(step, { ...bindings, steps: acc }, acc, ctx)
    acc[step.id] = last
  }
  return last
}

/** Run a single step; composite kinds recurse back into {@link runLocalSteps}. */
export async function runLocalStep(
  step: RunStep,
  bindings: Bindings,
  acc: Record<string, unknown>,
  ctx: LocalWalkerCtx,
): Promise<unknown> {
  switch (step.kind) {
    case "tool":
      return runTool({
        tool: step.tool,
        candidates: step.candidates,
        input: step.input(bindings),
        context: step.context ? step.context(bindings) : undefined,
        resolverContext: step.resolverContext,
        secrets: step.secrets,
        signal: ctx.signal,
      })

    case "transform":
      return step.compute(bindings)

    case "group":
      return runLocalSteps(step.steps, bindings, acc, ctx)

    case "branch": {
      const chosen = step.cond(bindings) ? step.then : (step.otherwise ?? [])
      return runLocalSteps(chosen, bindings, acc, ctx)
    }

    case "parallel": {
      const entries = await Promise.all(
        step.branches.map(async (branch) => {
          const branchAcc: Record<string, unknown> = {}
          const last = await runLocalSteps(branch.steps, bindings, branchAcc, ctx)
          Object.assign(acc, branchAcc) // later top-level siblings see nested ids too
          return [branch.id, last] as const
        }),
      )
      return Object.fromEntries(entries)
    }

    case "map": {
      const items = [...step.over(bindings)]
      const parallelism = Math.max(1, step.parallelism ?? 1)
      const results: unknown[] = new Array(items.length)
      for (let i = 0; i < items.length; i += parallelism) {
        const chunk = items.slice(i, i + parallelism)
        const outs = await Promise.all(
          chunk.map((item, j) => {
            const idx = i + j
            const itemBindings: Bindings = { ...bindings, item, index: idx }
            const inner = step.body(item, idx, itemBindings)
            return runLocalStep(inner, itemBindings, acc, ctx)
          }),
        )
        for (let j = 0; j < outs.length; j++) results[i + j] = outs[j]
      }
      return results
    }

    case "loop": {
      let iterations = 0
      let last: unknown
      let b = bindings
      while (iterations < step.maxIterations && step.while(b)) {
        last = await runLocalSteps(step.body, b, acc, ctx)
        b = { ...bindings, steps: acc }
        iterations++
      }
      return last
    }

    case "agent": {
      if (!ctx.agents) {
        throw new Error(
          `step '${step.id}': AgentStep requires an AgentSessionHost — pass ` +
            `opts.agents to toMastraWorkflow`,
        )
      }
      // Delegate to workflow-runtime's own AgentStep executor (spawn / prompt /
      // policy / outputSchema-retry) via an isolated one-step sub-run, rather
      // than re-implementing that logic here. Trade-off: `$steps.<id>` refs in
      // this step's selectors won't resolve (the sub-run's bindings.steps
      // starts empty) — only `$input.*` is threaded through. See README.
      const result = await runWorkflow({
        workflow: { id: `${step.id}__agent`, steps: [step] },
        input: bindings.input,
        agents: ctx.agents,
        cwd: ctx.cwd,
        workspaceSlug: ctx.workspaceSlug,
        signal: ctx.signal,
      })
      return result.output
    }

    case "subworkflow": {
      // SubworkflowStep is documented as running "with its own isolated
      // bindings" — runWorkflow's own fresh sub-run IS that isolation, not a
      // gap to work around.
      const childInput = step.input ? step.input(bindings) : bindings.input
      const result = await runWorkflow({
        workflow: step.workflow,
        input: childInput,
        agents: ctx.agents,
        cwd: ctx.cwd,
        workspaceSlug: ctx.workspaceSlug,
        signal: ctx.signal,
      })
      return result.output
    }

    case "suspend":
    case "approval":
    case "pipeline":
      // Unreachable: assertProjectable rejects these before the walker ever runs.
      throw new WorkflowProjectionError(
        `step '${step.id}' (kind '${step.kind}') reached the local walker — ` +
          `this should have been rejected by assertProjectable first`,
      )
  }
}
