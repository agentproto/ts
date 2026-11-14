/**
 * Descriptor bookkeeping for a connect-time model apply the ACP server
 * REJECTED (a transient 429 that outlived the client's bounded retry, or a
 * genuinely unknown id). The session is alive but running the adapter's own
 * default model, so the descriptor must stop claiming the requested one.
 *
 * Kept as a pure projection so the spawn path (`session-spawn.ts`) and the
 * restart / eager-resume path (`session-restart-core.ts`) record the same
 * shape — one place, no drift.
 */

import type { SessionConfigOption } from "@agentproto/acp/client"

export interface ModelApplyRejection {
  requested: string
  reason: string
}

export interface ModelApplyMismatch {
  rejection: ModelApplyRejection
  /** The model the adapter says it is actually on, when the connect-time
   *  config options expose it (`configOptions` entry for `model`). */
  reportedModel?: string
}

/** Read the model the adapter reports as CURRENT from its connect-time
 *  config-option snapshot. `undefined` when the wrapper advertises no model
 *  option (or no current value), never inferred. */
export function reportedModelFromConfigOptions(
  options: readonly SessionConfigOption[] | undefined,
): string | undefined {
  const modelOption = options?.find(option => option.id === "model")
  return modelOption && typeof modelOption.currentValue === "string" && modelOption.currentValue.length > 0
    ? modelOption.currentValue
    : undefined
}

/** Project an adapter session's model-apply outcome. `undefined` when the
 *  requested model applied cleanly (or none was requested). */
export function modelApplyMismatch(input: {
  rejection?: ModelApplyRejection
  availableConfigOptions?: readonly SessionConfigOption[]
}): ModelApplyMismatch | undefined {
  if (!input.rejection) return undefined
  const reportedModel = reportedModelFromConfigOptions(input.availableConfigOptions)
  return {
    rejection: input.rejection,
    ...(reportedModel ? { reportedModel } : {}),
  }
}

/** Human-readable warning for the descriptor's `session:harness-warning`
 *  event and the spawn result's `warnings` list. */
export function modelApplyWarning(mismatch: ModelApplyMismatch): string {
  const on = mismatch.reportedModel
    ? `the session is running "${mismatch.reportedModel}"`
    : "the session is running the adapter's default model"
  return (
    `[model] requested "${mismatch.rejection.requested}" was not applied by the adapter ` +
    `(${mismatch.rejection.reason}); ${on}.`
  )
}
