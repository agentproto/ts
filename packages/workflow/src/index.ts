/**
 * @agentproto/workflow — AIP-15 WORKFLOW.md `defineWorkflow` reference impl.
 *
 * A markdown + frontmatter format for declaring a multi-step agent workflow's abstract orchestration shape — its steps, branching, parallelism, approval gates, suspend/resume, and compensation. Pairs with the standard `defineWorkflow` / `defineStep` signatures. Implementation lives entirely in the per-step TOOL.md contracts and their AIP-30 DRIVER bindings; workflows themselves are pure orchestration data.
 *
 * Spec: https://agentproto.sh/docs/aip-15
 *
 * Authoring paths:
 *   - TS:  `defineWorkflow({...})` → `WorkflowHandle`
 *   - MD:  `parseWorkflowManifest(src) → workflowFromManifest({...})` → `WorkflowHandle`
 */

export const SPEC_NAME = "agentworkflow/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineWorkflow } from "./define-workflow.js"
export {
  harnessSchema,
  knowledgeSelectorSchema,
  type HarnessSchema,
  type KnowledgeSelectorSchema,
} from "./schema.js"
export type {
  WorkflowDefinition,
  WorkflowHandle,
  Step,
  StepAgent,
  StepGate,
  Harness,
  KnowledgeSelector,
} from "./types.js"
