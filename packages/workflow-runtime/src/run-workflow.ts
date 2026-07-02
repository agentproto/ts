/**
 * The step-walker. Executes a {@link RuntimeWorkflow} top-to-bottom, threading
 * each step's output into a run-scoped binding bag, and dispatching `tool`
 * steps through `@agentproto/driver` `runTool` (resolve DRIVER → validate input
 * + context → execute body → validate output). Composite steps (`map` /
 * `branch` / `loop` / `parallel` / `approval` / `subworkflow`) recurse over the
 * same bindings; `suspend` defers to the host's resume hook.
 */

import { runTool } from "@agentproto/driver"
import type { ZodError } from "zod"
import type {
  AgentStep,
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
  readonly maxTotalCostUsd?: number
  /** Last-known cost per session id; summed to get the run's total spend.
   *  A Map (not a running delta) so a session reused across steps via
   *  sessionRef is counted once, not double-counted. */
  readonly costBySession: Map<string, number>
}

interface RunCtx {
  readonly state: RunState
  readonly approve?: RunWorkflowArgs["approve"]
  readonly resume?: RunWorkflowArgs["resume"]
  readonly signal?: AbortSignal
  readonly agents?: RunWorkflowArgs["agents"]
  readonly cwd?: string
  readonly workspaceSlug?: string
}

function view(state: RunState, item?: unknown, index?: number): Bindings {
  return { input: state.input, steps: state.steps, item, index }
}

/** Resolve a value that is either a static string or a binding selector. */
function resolveSel(sel: string | ((bindings: Bindings) => string), b: Bindings): string {
  return typeof sel === "function" ? sel(b) : sel
}

/** Extract a JSON candidate from raw assistant text:
 *  1. last ```json fenced block if present, else
 *  2. last generic ``` fenced block if present, else
 *  3. the whole trimmed string. */
function extractJsonCandidate(raw: string): string {
  const jsonFence = /```json\s*([\s\S]*?)```/g
  const lastJson = lastMatch(jsonFence, raw)
  if (lastJson !== undefined) return lastJson

  const anyFence = /```\s*([\s\S]*?)```/g
  const lastAny = lastMatch(anyFence, raw)
  if (lastAny !== undefined) return lastAny

  return raw.trim()
}

function lastMatch(re: RegExp, s: string): string | undefined {
  let m: RegExpExecArray | null
  let last: RegExpExecArray | null = null
  while ((m = re.exec(s)) !== null) last = m
  return last ? last[1]?.trim() : undefined
}

function spentUsd(state: RunState): number {
  let total = 0
  for (const c of state.costBySession.values()) total += c
  return total
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`)
    .join(", ")
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
        agents: ctx.agents,
        cwd: ctx.cwd,
        workspaceSlug: ctx.workspaceSlug,
      })
      return child.output
    }

    case "agent": {
      if (!ctx.agents) throw new Error(`step '${step.id}': AgentStep requires a host agents implementation`)
      if (
        step.adapter &&
        ctx.state.maxTotalCostUsd !== undefined &&
        spentUsd(ctx.state) >= ctx.state.maxTotalCostUsd
      ) {
        throw new Error(
          `step '${step.id}': budget_exceeded — run spend $${spentUsd(ctx.state).toFixed(4)} >= cap $${ctx.state.maxTotalCostUsd}`,
        )
      }
      const sessionId = step.adapter
        ? await ctx.agents.spawn(resolveSel(step.adapter, b), { cwd: ctx.cwd, workspaceSlug: ctx.workspaceSlug, stepId: step.id })
        : ctx.agents.resolveByLabel(step.sessionRef!)
      if (!sessionId) throw new Error(`step '${step.id}': no session (adapter and sessionRef both unresolved)`)
      await ctx.agents.sendPromptAndWait(sessionId, step.prompt(b))
      if (step.policy && ctx.agents.onAwaitingInput) {
        await ctx.agents.onAwaitingInput(sessionId, step.policy)
      }

      if (ctx.agents.readCostUsd) {
        ctx.state.costBySession.set(sessionId, await ctx.agents.readCostUsd(sessionId))
      }

      if (!step.outputSchema) return { sessionId }

      // Validate-and-retry loop
      if (!ctx.agents.readFinalMessage) {
        throw new Error(`step '${step.id}': outputSchema requires a host with readFinalMessage`)
      }
      const maxRetries = step.maxRetries ?? 2
      let lastErr = ""
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const raw = await ctx.agents.readFinalMessage(sessionId)
        const candidate = extractJsonCandidate(raw)
        let value: unknown
        try {
          value = JSON.parse(candidate)
        } catch {
          lastErr = "not valid JSON"
          if (attempt < maxRetries) {
            await ctx.agents.sendPromptAndWait(
              sessionId,
              `Your previous reply did not match the required schema: ${lastErr}. ` +
                `Reply again with ONLY a JSON object that matches. No prose, no code fence needed.`,
            )
          }
          continue
        }
        const res = step.outputSchema.safeParse(value)
        if (res.success) return { sessionId, output: res.data }
        lastErr = formatZodError(res.error)
        if (attempt < maxRetries) {
          await ctx.agents.sendPromptAndWait(
            sessionId,
            `Your previous reply did not match the required schema: ${lastErr}. ` +
              `Reply again with ONLY a JSON object that matches. No prose, no code fence needed.`,
          )
        }
      }
      throw new Error(`step '${step.id}': output_invalid — final message never matched outputSchema (${lastErr})`)
    }
  }
}

async function runWorkflowInner(
  workflow: RuntimeWorkflow,
  input: unknown,
  hooks: Pick<RunCtx, "approve" | "resume" | "signal" | "agents" | "cwd" | "workspaceSlug">,
  maxTotalCostUsd?: number,
): Promise<WorkflowRunResult> {
  const state: RunState = { input, steps: {}, costBySession: new Map(), maxTotalCostUsd }
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
    agents: args.agents,
    cwd: args.cwd,
    workspaceSlug: args.workspaceSlug,
  }, args.maxTotalCostUsd)
}
