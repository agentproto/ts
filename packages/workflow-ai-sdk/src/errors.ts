/**
 * Thrown eagerly — at wrap time, before the returned tool is ever called —
 * when a compiled workflow's step graph contains a kind
 * {@link toAiSdkWorkflowTool} can't represent as one tool call.
 */
export class WorkflowProjectionError extends Error {
  constructor(message: string) {
    super(`toAiSdkWorkflowTool: ${message}`)
    this.name = "WorkflowProjectionError"
  }
}
