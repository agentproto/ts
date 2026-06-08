/**
 * The step-walker. Executes a {@link RuntimeWorkflow} top-to-bottom, threading
 * each step's output into a run-scoped binding bag, and dispatching `tool`
 * steps through `@agentproto/driver` `runTool` (resolve DRIVER → validate input
 * + context → execute body → validate output). Composite steps (`map` /
 * `branch` / `loop` / `parallel` / `approval` / `subworkflow`) recurse over the
 * same bindings; `suspend` defers to the host's resume hook.
 */

import { runTool } from "@agentproto/driver"
import type {
  Bindings,
  RunStep,
  RunWorkflowArgs,
  RuntimeWorkflow,
  WorkflowRunResult,
} from "./types.js"

/** Thrown by a `suspend` step when no host `resume` hook is provided. */
export class WorkflowSuspendedError extends Error {
  constructor(
    readonly stepId: string,
    readonly on: readonly string[],
  ) {
    super(
      `workflow suspended at step '${stepId}' awaiting [${on.join(", ")}] — ` +
        `no resume hook supplied`,
    )
    this.name = "WorkflowSuspendedError"
  }
}

interface RunState {
  readonly input: unknown
  readonly steps: Record<string, unknown>
}

interface RunCtx {
  readonly state: RunState
  readonly approve?: RunWorkflowArgs["approve"]
  readonly resume?: RunWorkflowArgs["resume"]
  readonly signal?: AbortSignal
}

function view(state: RunState, item?: unknown, index?: number): Bindings {
  return { input: state.input, steps: state.steps, item, index }
}

/** Run an ordered list of steps, binding each output under its id; return last. */
async function runSequence(
  steps: readonly RunStep[],
  ctx: RunCtx,
  item: unknown,
  index: number | undefined,
): Promise<unknown> {
  let last: unknown
  for (const s of steps) {
    const out = await execStep(s, ctx, item, index)
    ctx.state.steps[s.id] = out
    last = out
  }
  return last
}

async function execStep(
  step: RunStep,
  ctx: RunCtx,
  item: unknown,
  index: number | undefined,
): Promise<unknown> {
  const { state, signal } = ctx
  const b = view(state, item, index)
  switch (step.kind) {
    case "tool":
      return runTool({
        tool: step.tool,
        candidates: step.candidates,
        input: step.input(b),
        context: step.context ? step.context(b) : undefined,
        resolverContext: step.resolverContext,
        secrets: step.secrets,
        signal,
      })

    case "transform":
      return step.compute(b)

    case "map": {
      const arr = [...step.over(b)]
      const parallelism = Math.max(1, step.parallelism ?? 1)
      const results: unknown[] = new Array(arr.length)
      for (let i = 0; i < arr.length; i += parallelism) {
        const chunk = arr.slice(i, i + parallelism)
        const outs = await Promise.all(
          chunk.map((el, j) => {
            const idx = i + j
            const inner = step.body(el, idx, view(state, el, idx))
            return execStep(inner, ctx, el, idx)
          }),
        )
        for (let j = 0; j < outs.length; j++) results[i + j] = outs[j]
      }
      return results
    }

    case "branch": {
      const chosen = step.cond(b) ? step.then : (step.otherwise ?? [])
      return runSequence(chosen, ctx, item, index)
    }

    case "loop": {
      let iterations = 0
      let last: unknown
      while (
        iterations < step.maxIterations &&
        step.while(view(state, item, index))
      ) {
        last = await runSequence(step.body, ctx, item, index)
        iterations++
      }
      return last
    }

    case "parallel": {
      const outs = await Promise.all(
        step.branches.map((br) =>
          runSequence(br.steps, ctx, item, index).then((last) => ({
            id: br.id,
            last,
          })),
        ),
      )
      const record: Record<string, unknown> = {}
      for (const { id, last } of outs) record[id] = last
      return record
    }

    case "approval": {
      const prompt = step.prompt(b)
      const approvers = step.approvers ?? []
      const approved = ctx.approve
        ? await ctx.approve({ stepId: step.id, prompt, approvers })
        : true
      const followups = approved
        ? (step.onApprove ?? [])
        : (step.onReject ?? [])
      await runSequence(followups, ctx, item, index)
      return { approved }
    }

    case "suspend": {
      if (!ctx.resume) throw new WorkflowSuspendedError(step.id, step.on)
      return ctx.resume({ stepId: step.id, on: step.on })
    }

    case "group":
      return runSequence(step.steps, ctx, item, index)

    case "subworkflow": {
      const childInput = step.input ? step.input(b) : state.input
      const child = await runWorkflowInner(step.workflow, childInput, {
        approve: ctx.approve,
        resume: ctx.resume,
        signal,
      })
      return child.output
    }
  }
}

async function runWorkflowInner(
  workflow: RuntimeWorkflow,
  input: unknown,
  hooks: Pick<RunCtx, "approve" | "resume" | "signal">,
): Promise<WorkflowRunResult> {
  const state: RunState = { input, steps: {} }
  const ctx: RunCtx = { state, ...hooks }
  let lastId: string | undefined
  for (const step of workflow.steps) {
    const out = await execStep(step, ctx, undefined, undefined)
    state.steps[step.id] = out
    lastId = step.id
  }
  const bindings = view(state)
  const output = workflow.output
    ? workflow.output(bindings)
    : lastId !== undefined
      ? state.steps[lastId]
      : undefined
  return { output, bindings }
}

export async function runWorkflow(
  args: RunWorkflowArgs,
): Promise<WorkflowRunResult> {
  return runWorkflowInner(args.workflow, args.input, {
    approve: args.approve,
    resume: args.resume,
    signal: args.signal,
  })
}
