/**
 * @agentproto/workflow-mastra — project a compiled AIP-15 {@link RuntimeWorkflow}
 * onto a Mastra `createWorkflow`. Runtime projection (the compiled workflow
 * already carries live `ToolHandle` + `DriverHandle[]` candidates per tool
 * step — same inputs `runTool` already dispatches), not codegen: nothing
 * here emits a `.ts` file to hand-edit, matching
 * `packages/workflow/README.md`'s design spec for why WORKFLOW.md doesn't
 * need the PROCEDURE.md → Mastra codegen precedent's "generated file meant
 * to be hand-customized" shape — a WORKFLOW.md's steps run as declared.
 *
 * See the package README for the full step-kind → Mastra primitive table
 * and the documented fidelity limitations.
 */

import { createStep, createWorkflow } from "@mastra/core/workflows"
import { z } from "zod"
import type {
  AgentSessionHost,
  BranchStep,
  Bindings,
  LoopStep,
  MapStep,
  ParallelStep,
  RunStep,
  RuntimeWorkflow,
} from "@agentproto/workflow-runtime"

import { assertProjectable } from "./assert-projectable.js"
import { runLocalStep, runLocalSteps, type LocalWalkerCtx } from "./local-walker.js"

export { WorkflowProjectionError } from "./errors.js"

export interface ToMastraWorkflowOptions {
  /** Host-injected agent session runtime. Required only if the workflow has `agent` steps. */
  agents?: AgentSessionHost
  /** Working directory for spawned agent sessions / subworkflow runs. */
  cwd?: string
  /** Workspace slug for spawned agent sessions. */
  workspaceSlug?: string
}

// Mastra's step/workflow generics are deeply parameterized on schema shape
// (see @mastra/core/dist/workflows/{step,workflow}.d.ts) — this projector
// deals in a dynamically-shaped step graph, so every step here declares
// `z.any()` in/out and the builder chain is threaded as `any`, mirroring
// @agentproto/adapter-ai-sdk's own documented `dynamicTool` escape hatch for
// the same reason: the static generics can't be satisfied by a value whose
// shape is only known at projection time, even though it's structurally valid.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWorkflowBuilder = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStepParams = any

/** Read the run-scoped `input`/`steps` bindings back out of Mastra's own per-run `state`. */
function bindingsFromParams(params: AnyStepParams): Bindings {
  const priorSteps = (params.state as { steps?: Record<string, unknown> } | undefined)?.steps ?? {}
  return { input: params.getInitData(), steps: { ...priorSteps } }
}

/** Merge a patch into Mastra's per-run `state.steps` bag (read-modify-write). */
async function mergeStateSteps(params: AnyStepParams, patch: Record<string, unknown>): Promise<void> {
  const prior = (params.state as { steps?: Record<string, unknown> } | undefined)?.steps ?? {}
  await params.setState({ steps: { ...prior, ...patch } })
}

/** Atomic Mastra step for a `tool` / `transform` / `agent` / `group` / `subworkflow` RunStep. */
function atomicWrapper(step: RunStep, ctx: LocalWalkerCtx): AnyWorkflowBuilder {
  return createStep({
    id: step.id,
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async (params: AnyStepParams) => {
      const bindings = bindingsFromParams(params)
      const acc: Record<string, unknown> = { ...bindings.steps }
      const output = await runLocalSteps([step], bindings, acc, ctx)
      await mergeStateSteps(params, acc)
      return output
    },
  })
}

/** Pass a value through and bind it into `state.steps[id]` — used after a Mastra
 *  combinator (`.parallel()`/`.foreach()`/`.dowhile()`) whose own output shape
 *  we don't rely on for anything but this final bookkeeping step. */
function bindResultStep(id: string): AnyWorkflowBuilder {
  return createStep({
    id: `${id}__bind`,
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async (params: AnyStepParams) => {
      await mergeStateSteps(params, { [id]: params.inputData })
      return params.inputData
    },
  })
}

function branchArm(step: BranchStep, armSteps: readonly RunStep[], label: string, ctx: LocalWalkerCtx): AnyWorkflowBuilder {
  return createStep({
    id: `${step.id}__${label}`,
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async (params: AnyStepParams) => {
      const bindings = bindingsFromParams(params)
      const acc: Record<string, unknown> = { ...bindings.steps }
      const output = await runLocalSteps(armSteps, bindings, acc, ctx)
      acc[step.id] = output // bind under the ORIGINAL BranchStep's id, not the arm's synthetic one
      await mergeStateSteps(params, acc)
      return output
    },
  })
}

function attachBranch(wf: AnyWorkflowBuilder, step: BranchStep, ctx: LocalWalkerCtx): AnyWorkflowBuilder {
  const cond = (params: AnyStepParams) => step.cond(bindingsFromParams(params))
  return wf.branch([
    [(params: AnyStepParams) => cond(params), branchArm(step, step.then, "then", ctx)],
    [(params: AnyStepParams) => !cond(params), branchArm(step, step.otherwise ?? [], "else", ctx)],
  ])
}

function parallelBranch(step: ParallelStep, branch: ParallelStep["branches"][number], ctx: LocalWalkerCtx): AnyWorkflowBuilder {
  return createStep({
    id: `${step.id}__${branch.id}`,
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async (params: AnyStepParams) => {
      const bindings = bindingsFromParams(params)
      // A LOCAL-only `acc`, deliberately not merged into the shared Mastra
      // `state` from here: branches run concurrently, and `state`/`setState`
      // is a plain read-modify-write with no compare-and-swap, so two
      // branches merging at once silently lose one branch's write. Returning
      // the output and letting `finalizeParallel` read Mastra's OWN
      // concurrency-safe `.parallel()` result (proven correct by the same
      // aggregation `.foreach()` already relies on) avoids that race — the
      // documented trade-off is that a step id nested INSIDE one parallel
      // branch isn't visible to a step OUTSIDE the parallel block (it's
      // still visible to later steps within the SAME branch, via this local
      // `acc`).
      const acc: Record<string, unknown> = { ...bindings.steps }
      return runLocalSteps(branch.steps, bindings, acc, ctx)
    },
  })
}

function finalizeParallel(step: ParallelStep): AnyWorkflowBuilder {
  return createStep({
    id: `${step.id}__finalize`,
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async (params: AnyStepParams) => {
      // `params.inputData` is Mastra's own safely-aggregated `.parallel()`
      // result, keyed by each branch step's (synthetic) Mastra step id.
      const raw = (params.inputData as Record<string, unknown> | undefined) ?? {}
      const record: Record<string, unknown> = {}
      for (const branch of step.branches) record[branch.id] = raw[`${step.id}__${branch.id}`]
      await mergeStateSteps(params, { [step.id]: record })
      return record
    },
  })
}

function attachParallel(wf: AnyWorkflowBuilder, step: ParallelStep, ctx: LocalWalkerCtx): AnyWorkflowBuilder {
  return wf.parallel(step.branches.map((branch) => parallelBranch(step, branch, ctx))).then(finalizeParallel(step))
}

function computeMapItems(step: MapStep): AnyWorkflowBuilder {
  return createStep({
    id: `${step.id}__items`,
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async (params: AnyStepParams) => [...step.over(bindingsFromParams(params))],
  })
}

function mapBody(step: MapStep, ctx: LocalWalkerCtx): AnyWorkflowBuilder {
  return createStep({
    id: `${step.id}__body`,
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async (params: AnyStepParams) => {
      const outer = bindingsFromParams(params)
      const item = params.inputData
      // `.foreach()` doesn't expose the element's index to the body step, so
      // `$index` isn't resolvable inside a projected map body — documented
      // in the README alongside the other fidelity gaps.
      const itemBindings: Bindings = { ...outer, item, index: undefined }
      const acc: Record<string, unknown> = { ...outer.steps }
      const inner = step.body(item, -1, itemBindings)
      return runLocalStep(inner, itemBindings, acc, ctx)
      // Deliberately not merged back into shared `state`: foreach iterations
      // run concurrently (a `setState` race), and per-item nested ids aren't
      // addressable from outside the map in the engine's own model either.
    },
  })
}

function attachMap(wf: AnyWorkflowBuilder, step: MapStep, ctx: LocalWalkerCtx): AnyWorkflowBuilder {
  return wf
    .then(computeMapItems(step))
    .foreach(mapBody(step, ctx), step.parallelism ? { concurrency: step.parallelism } : undefined)
    .then(bindResultStep(step.id))
}

function loopBody(step: LoopStep, ctx: LocalWalkerCtx): AnyWorkflowBuilder {
  return createStep({
    id: `${step.id}__body`,
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async (params: AnyStepParams) => {
      const bindings = bindingsFromParams(params)
      // Mastra's `.dowhile()` checks its condition AFTER the body runs (do-
      // semantics); the engine's LoopStep checks `while` BEFORE every
      // iteration, including the first. Guarding here keeps the body's side
      // effects (tool calls) from firing on an already-false condition — the
      // `.dowhile()` condition below still fires once more to actually stop
      // the loop, but no step work happens on that trailing check.
      if (!step.while(bindings)) return undefined
      const acc: Record<string, unknown> = { ...bindings.steps }
      const output = await runLocalSteps(step.body, bindings, acc, ctx)
      await mergeStateSteps(params, acc)
      return output
    },
  })
}

function attachLoop(wf: AnyWorkflowBuilder, step: LoopStep, ctx: LocalWalkerCtx): AnyWorkflowBuilder {
  return wf
    .dowhile(loopBody(step, ctx), async (params: AnyStepParams) => {
      const bindings = bindingsFromParams(params)
      // `iterationCount` is Mastra's own native loop counter — enforcing
      // `maxIterations` here closes the gap `packages/workflow/README.md`'s
      // design spec flagged ("no hard iteration cap ... not solved here").
      return step.while(bindings) && params.iterationCount < step.maxIterations
    })
    .then(bindResultStep(step.id))
}

function attachStep(wf: AnyWorkflowBuilder, step: RunStep, ctx: LocalWalkerCtx): AnyWorkflowBuilder {
  switch (step.kind) {
    case "branch":
      return attachBranch(wf, step, ctx)
    case "parallel":
      return attachParallel(wf, step, ctx)
    case "map":
      return attachMap(wf, step, ctx)
    case "loop":
      return attachLoop(wf, step, ctx)
    default:
      // tool / transform / agent / group / subworkflow: one opaque step.
      return wf.then(atomicWrapper(step, ctx))
  }
}

/**
 * Project a compiled {@link RuntimeWorkflow} onto a Mastra `createWorkflow`.
 * Throws {@link WorkflowProjectionError} eagerly — before building any Mastra
 * primitive — if the step graph (including nested `subworkflow` children)
 * contains a `suspend`, `approval`, or `pipeline` step; see the README for why.
 */
export function toMastraWorkflow(
  compiled: RuntimeWorkflow,
  opts: ToMastraWorkflowOptions = {},
): AnyWorkflowBuilder {
  assertProjectable(compiled.steps)
  const ctx: LocalWalkerCtx = { agents: opts.agents, cwd: opts.cwd, workspaceSlug: opts.workspaceSlug }

  let wf: AnyWorkflowBuilder = createWorkflow({
    id: compiled.id,
    description: compiled.description,
    inputSchema: z.any(),
    outputSchema: z.any(),
  })
  for (const step of compiled.steps) {
    wf = attachStep(wf, step, ctx)
  }
  return wf.commit()
}
