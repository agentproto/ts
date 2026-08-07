/**
 * Shared `AgentStep` construction — the one place that applies AgentStep's
 * defaults (`policy` → `{ awaiting: "fail" }`, a literal `prompt` wrapped as
 * a `Selector`). Used by both `compileWorkflow`'s declarative `kind:"agent"`
 * step and `@agentproto/runtime`'s `translateStages` (the `workflow_start` /
 * `WorkflowRunner` path), so the two authoring surfaces stay byte-identical
 * instead of drifting apart.
 */

import type { AgentSandboxRef, AgentStep, Bindings, Selector } from "./types.js"

export interface AgentStepFields {
  /** A literal prompt string, or a per-run selector (declarative manifest
   *  steps resolve `$steps.*` refs into one before calling this). */
  prompt: string | Selector<string>
  adapter?: string
  sessionRef?: string
  sandbox?: AgentSandboxRef
  cacheable?: boolean
  policy?: AgentStep["policy"]
  outputSchema?: AgentStep["outputSchema"]
  maxRetries?: number
  options?: Record<string, boolean | number | string>
}

/** Build a runtime {@link AgentStep} from field values, applying the same
 *  defaults everywhere: `policy` defaults to `{ awaiting: "fail" }`. */
export function buildAgentStep(id: string, fields: AgentStepFields): AgentStep {
  const prompt = fields.prompt
  return {
    kind: "agent",
    id,
    ...(fields.adapter !== undefined ? { adapter: fields.adapter } : {}),
    ...(fields.sessionRef !== undefined ? { sessionRef: fields.sessionRef } : {}),
    ...(fields.sandbox !== undefined ? { sandbox: fields.sandbox } : {}),
    ...(fields.cacheable ? { cacheable: true } : {}),
    ...(fields.options !== undefined ? { options: fields.options } : {}),
    prompt: typeof prompt === "function" ? prompt : ((_b: Bindings) => prompt),
    policy: fields.policy ?? { awaiting: "fail" as const },
    ...(fields.outputSchema !== undefined ? { outputSchema: fields.outputSchema } : {}),
    ...(fields.maxRetries !== undefined ? { maxRetries: fields.maxRetries } : {}),
  }
}
