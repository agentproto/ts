/**
 * @agentproto/workflow-loader — the host-side disk loader for AIP-15
 * WORKFLOW.md. Reads a manifest, imports its optional entry module, and
 * reconciles the two. The pure @agentproto/workflow (parse) and
 * @agentproto/workflow-runtime (compile) packages deliberately omit I/O; this
 * is where it lives.
 */

export { loadWorkflowHandle, WorkflowLoadError } from "./load-workflow.js"
export { reconcileEntry, WorkflowReconcileError } from "./reconcile.js"
