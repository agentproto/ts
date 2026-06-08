/**
 * @agentproto/workflow-runtime — the AIP-15 step-walker.
 *
 * Executes a typed step graph (tool / map / branch / loop / transform) over
 * `@agentproto/driver` `runTool`, threading each step's output into a
 * run-scoped binding bag (the AIP-16 IO seam, expressed as typed selectors).
 * Framework-only: it knows nothing about any specific tool or domain — those
 * are catalogue declarations injected as `candidates`.
 */

export { runWorkflow, WorkflowSuspendedError } from "./run-workflow.js"
export {
  compileWorkflow,
  WorkflowCompileError,
  resolveRef,
  resolveValue,
  evalPredicate,
  type CompileWorkflowOptions,
} from "./compile-workflow.js"
export type {
  Bindings,
  Selector,
  RunStep,
  ToolStep,
  TransformStep,
  MapStep,
  BranchStep,
  LoopStep,
  ParallelStep,
  ApprovalStep,
  SuspendStep,
  GroupStep,
  SubworkflowStep,
  RuntimeWorkflow,
  RunWorkflowArgs,
  ApprovalRequest,
  ResumeRequest,
  WorkflowRunResult,
} from "./types.js"
