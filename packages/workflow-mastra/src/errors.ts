/**
 * Thrown eagerly — before any Mastra primitive is built — when a compiled
 * workflow's step graph contains a kind {@link toMastraWorkflow} can't
 * represent. Never a silent drop: every unmappable step surfaces as one of
 * these, naming the exact step id/kind/path that tripped it.
 */
export class WorkflowProjectionError extends Error {
  constructor(message: string) {
    super(`toMastraWorkflow: ${message}`)
    this.name = "WorkflowProjectionError"
  }
}
