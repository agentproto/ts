/**
 * @agentproto/workflow-ai-sdk — project a compiled AIP-15 {@link RuntimeWorkflow}
 * onto a Vercel AI SDK tool. Per `packages/workflow/README.md`'s design spec:
 * AI SDK has no first-class step-graph primitive to reconcile against (its
 * unit is a tool-calling loop), so unlike the Mastra projection this is
 * close to a no-op — `@agentproto/workflow-runtime`'s `runWorkflow` is
 * already a portable, dependency-light async function, so the whole
 * compiled workflow runs behind ONE `dynamicTool` call. Same
 * `dynamicTool`-over-the-typed-`tool`-overloads choice
 * `@agentproto/adapter-ai-sdk`'s `toAiSdkTool` makes, for the same reason:
 * a value whose shape is only known at projection time can't satisfy AI
 * SDK's static generics even though it's structurally valid.
 */

import { dynamicTool } from "ai"
import type { Tool as AiTool, ToolCallOptions } from "ai"
import { z } from "zod"
import {
  runWorkflow,
  type AgentSessionHost,
  type ApprovalRequest,
  type ResumeRequest,
  type RuntimeWorkflow,
  type StepCache,
} from "@agentproto/workflow-runtime"

import { assertProjectable } from "./assert-projectable.js"

export { WorkflowProjectionError } from "./errors.js"

export interface ToAiSdkWorkflowToolOptions {
  /** Tool description surfaced to the model. Defaults to the workflow's own `description`. */
  description?: string
  /** Host-injected agent session runtime. Undefined ⇒ any `agent` step throws at run time. */
  agents?: AgentSessionHost
  /** Working directory for spawned agent sessions. */
  cwd?: string
  /** Workspace slug for spawned agent sessions. */
  workspaceSlug?: string
  /** Decide an ApprovalStep nested inside a `subworkflow`. Default: auto-approve. */
  approve?: (req: ApprovalRequest) => boolean | Promise<boolean>
  /** Supply a SuspendStep's resume payload nested inside a `subworkflow`. Default: throw + suspend. */
  resume?: (req: ResumeRequest) => unknown | Promise<unknown>
  /** Opt-in journal cache for cacheable steps. */
  cache?: StepCache
  cacheKey?: string
  /** Run-level cost ceiling (USD) for spawned agent sessions. */
  maxTotalCostUsd?: number
}

/**
 * Project a compiled {@link RuntimeWorkflow} onto an AI SDK `dynamicTool`
 * that runs the whole workflow through `runWorkflow` behind one call.
 * Throws {@link WorkflowProjectionError} eagerly — at wrap time, not on the
 * model's first call — if the step graph (including nested `subworkflow`
 * children) contains a `suspend`, `approval`, or `pipeline` step.
 *
 * `approve`/`resume` are still accepted (and wired through to `runWorkflow`)
 * for `subworkflow` children — the eager rejection only covers steps
 * reachable from the TOP-LEVEL compiled workflow itself, since a workflow
 * exposed as one tool call has no way to surface a live approval/suspend
 * decision back to the caller mid-call for ITS OWN steps.
 */
export function toAiSdkWorkflowTool(
  compiled: RuntimeWorkflow,
  opts: ToAiSdkWorkflowToolOptions = {},
): AiTool<unknown, unknown> & { type: "dynamic" } {
  assertProjectable(compiled.steps)
  return dynamicTool({
    description: opts.description ?? compiled.description ?? `Run the '${compiled.id}' workflow.`,
    inputSchema: z.unknown(),
    execute: async (input: unknown, options: ToolCallOptions) => {
      const result = await runWorkflow({
        workflow: compiled,
        input,
        agents: opts.agents,
        cwd: opts.cwd,
        workspaceSlug: opts.workspaceSlug,
        approve: opts.approve,
        resume: opts.resume,
        cache: opts.cache,
        cacheKey: opts.cacheKey,
        maxTotalCostUsd: opts.maxTotalCostUsd,
        signal: options.abortSignal,
      })
      return result.output
    },
  })
}
