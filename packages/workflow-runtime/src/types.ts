/**
 * Typed step algebra for AIP-15 WORKFLOW execution.
 *
 * The AIP-15 manifest leaves the IO-threading (`step.inputs`, `map.over`,
 * `branch.when`, `loop.while`) to a meta-validator — it never pins an
 * expression language. Rather than invent a stringly DSL, this runtime
 * expresses the AIP-16 IO seam as **typed selectors**: each step reads the
 * run-scoped {@link Bindings} (workflow input + every prior step's output, plus
 * the current item inside a `map`) through a plain `(bindings) => value`
 * function. Authoring stays in TypeScript; compiling a declarative manifest's
 * reference strings onto these selectors is a separable follow-up.
 */

import type { DriverHandle, ResolverContext } from "@agentproto/driver"
import type { ToolContext, ToolHandle } from "@agentproto/tool"
import type { ZodType } from "zod"

/** The run-scoped data every selector reads from. */
export interface Bindings {
  /** The workflow's invocation input. */
  readonly input: unknown
  /** Each completed top-level step's output, keyed by step id. */
  readonly steps: Readonly<Record<string, unknown>>
  /** Present inside a `map` body — the element being processed. */
  readonly item?: unknown
  /** Present inside a `map` body — the element's index. */
  readonly index?: number
}

/** The AIP-16 IO seam: read a value out of the run bindings. */
export type Selector<T> = (bindings: Bindings) => T

/** Run a TOOL contract through the resolver; its output binds under `id`. */
export interface ToolStep<
  TInput = unknown,
  TOutput = unknown,
  TContext extends ToolContext = ToolContext,
> {
  kind: "tool"
  id: string
  tool: ToolHandle<TInput, TOutput, TContext>
  candidates: readonly DriverHandle[]
  /** Derive the tool input from the run bindings. */
  input: Selector<TInput>
  /** Derive the injected per-call context (live capabilities) from bindings. */
  context?: Selector<TContext>
  resolverContext?: ResolverContext
  secrets?: Record<string, string>
}

/** A pure in-run computation (combine / filter / shape) — no tool dispatch. */
export interface TransformStep {
  kind: "transform"
  id: string
  compute: Selector<unknown>
}

/**
 * Run a sub-step once per element of an array, optionally with bounded
 * concurrency. The element + index are exposed to the body via `bindings.item`
 * / `bindings.index`; the collected outputs bind under this step's id.
 */
export interface MapStep {
  kind: "map"
  id: string
  over: Selector<readonly unknown[]>
  /** Max concurrent bodies (default 1 = sequential). */
  parallelism?: number
  body: (item: unknown, index: number, bindings: Bindings) => RunStep
}

/** Run one of two branches based on a predicate over the bindings. */
export interface BranchStep {
  kind: "branch"
  id: string
  cond: Selector<boolean>
  then: readonly RunStep[]
  otherwise?: readonly RunStep[]
}

/** Repeat a body while a predicate holds, up to a hard iteration ceiling. */
export interface LoopStep {
  kind: "loop"
  id: string
  while: Selector<boolean>
  maxIterations: number
  body: readonly RunStep[]
}

/** Run several independent branches concurrently; outputs bind by branch id. */
export interface ParallelStep {
  kind: "parallel"
  id: string
  branches: readonly { id: string; steps: readonly RunStep[] }[]
}

/**
 * AIP-7 human-in-the-loop gate. The host's injected `approve` callback decides;
 * the chosen `onApprove` / `onReject` sub-steps then run. Default (no callback)
 * auto-approves. The step's own output is `{ approved }`.
 */
export interface ApprovalStep {
  kind: "approval"
  id: string
  prompt: Selector<string>
  approvers?: readonly string[]
  onApprove?: readonly RunStep[]
  onReject?: readonly RunStep[]
}

/**
 * Pause until an external event resumes the run. The host's injected `resume`
 * callback supplies the resume payload (bound under this step's id). With no
 * callback the run throws {@link WorkflowSuspendedError} — the durable-suspend
 * path a host persists and re-enters later.
 */
export interface SuspendStep {
  kind: "suspend"
  id: string
  on: readonly string[]
  timeoutMs?: number
}

/** Run an ordered list of steps as one unit; its output is the last step's. */
export interface GroupStep {
  kind: "group"
  id: string
  steps: readonly RunStep[]
}

/** Run a nested workflow with its own isolated bindings; its output binds here. */
export interface SubworkflowStep {
  kind: "subworkflow"
  id: string
  workflow: RuntimeWorkflow
  /** Input for the child (default: the parent's workflow input). */
  input?: Selector<unknown>
}

/**
 * Spawn or reuse an agent session and send it a prompt, waiting for the
 * turn to complete. The host injects an {@link AgentSessionHost} — this
 * runtime has no knowledge of concrete session registries or event buses.
 */
export interface AgentStep {
  kind: "agent"
  id: string
  /** Adapter slug to spawn a NEW session. Omit to reuse via sessionRef. */
  adapter?: Selector<string> | string
  /** Reuse an earlier AgentStep's spawned session, by that step's id. */
  sessionRef?: string
  /** Prompt to send. */
  prompt: Selector<string>
  policy?:
    | { awaiting: "auto-allow"; prompt: string }
    | { awaiting: "escalate"; webhookUrl?: string; timeoutMs?: number }
    | { awaiting: "fail" }
  /** Validate the session's final message against this schema; re-prompt on mismatch. */
  outputSchema?: ZodType<unknown>
  /** Re-prompt-and-retry attempts on schema mismatch before failing. Default 2. */
  maxRetries?: number
}

/**
 * The element generics on `ToolStep` are erased to `any` so heterogeneous
 * steps (different contracts, different input/output/context types) coexist in
 * one `steps[]` array — per-step type safety is enforced where each step is
 * authored, not at the collection level. Same contravariant-function-position
 * constraint `@agentproto/driver`'s `implementations[]` works around (TS
 * issue #21534); tightening the union to `ToolStep<unknown, …>` rejects a
 * concrete `ToolStep<MarketSearchInput, …>` on the zod `ZodType<T>` variance.
 */
export type RunStep =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | ToolStep<any, any, any>
  | TransformStep
  | MapStep
  | BranchStep
  | LoopStep
  | ParallelStep
  | ApprovalStep
  | SuspendStep
  | GroupStep
  | SubworkflowStep
  | AgentStep

export interface RuntimeWorkflow {
  id: string
  description?: string
  steps: readonly RunStep[]
  /** Pick the run's final output (default: the last top-level step's output). */
  output?: Selector<unknown>
}

export interface ApprovalRequest {
  stepId: string
  prompt: string
  approvers: readonly string[]
}

export interface ResumeRequest {
  stepId: string
  on: readonly string[]
}

export interface AgentSessionHost {
  /** Spawn a new agent session and return its id. */
  spawn(adapter: string, opts: { cwd?: string; workspaceSlug?: string; stepId?: string }): Promise<string>
  /** Send a prompt to an existing session and wait for its turn to end. */
  sendPromptAndWait(sessionId: string, prompt: string): Promise<void>
  /** Look up a session by the step id that spawned it (for sessionRef reuse). */
  resolveByLabel(stepId: string): string | undefined
  /** Handle an awaiting-input policy for a session. */
  onAwaitingInput?(sessionId: string, policy: AgentStep["policy"]): Promise<void>
  /** Return the session's final assistant message text (for outputSchema validation). */
  readFinalMessage?(sessionId: string): Promise<string>
  /** Current cumulative cost (USD) of a session, for run-level budgeting. */
  readCostUsd?(sessionId: string): Promise<number>
}

export interface RunWorkflowArgs {
  workflow: RuntimeWorkflow
  input?: unknown
  signal?: AbortSignal
  /** Decide an {@link ApprovalStep}. Default: auto-approve. */
  approve?: (req: ApprovalRequest) => boolean | Promise<boolean>
  /** Supply a {@link SuspendStep}'s resume payload. Default: throw + suspend. */
  resume?: (req: ResumeRequest) => unknown | Promise<unknown>
  /** Host-injected agent session runtime. Undefined ⇒ {@link AgentStep} throws. */
  agents?: AgentSessionHost
  /** Working directory for spawned agent sessions. */
  cwd?: string
  /** Workspace slug for spawned agent sessions. */
  workspaceSlug?: string
  /** Run-level cost ceiling (USD). Once the summed cost of spawned sessions
   *  reaches this, the next AgentStep spawn fails with `budget_exceeded`. */
  maxTotalCostUsd?: number
}

export interface WorkflowRunResult {
  output: unknown
  bindings: Bindings
}
