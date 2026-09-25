import { MastraError } from "@mastra/core/error"

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

/** AIP-58 §10 shape for a rejected run's input — mirrors (without importing,
 *  to avoid a hard dependency loop) `@agentproto/workflow-runtime`'s own
 *  `WorkflowInputValidation`'s failure case. */
export interface MastraInputValidationError {
  code: "invalid-input"
  fields: readonly string[]
  message: string
}

/**
 * Map the error `run.start()` throws when the projected workflow's own
 * `inputSchema` (see {@link toMastraWorkflow}'s `inputsSchema` option)
 * rejects `inputData`, to the same `{ code: "invalid-input", fields, message
 * }` shape `validateWorkflowInput` produces — so a caller doesn't need to
 * know Mastra threw a `MastraError` with id `WORKFLOW_SCHEMA_VALIDATION_FAILED`
 * and parse its message by hand. `undefined` for any other error (including a
 * step-level failure, which this projector never wants confused with a
 * rejected run).
 */
export function mapMastraInputError(err: unknown): MastraInputValidationError | undefined {
  if (!(err instanceof MastraError) || err.id !== "WORKFLOW_SCHEMA_VALIDATION_FAILED") return undefined
  const fields = [...new Set([...err.message.matchAll(/\n-\s*([^:]+):/g)].map((m) => m[1]!.trim()))]
  return { code: "invalid-input", fields, message: err.message }
}
