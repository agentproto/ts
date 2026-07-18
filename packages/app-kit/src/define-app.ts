/**
 * `defineApp({ agent, systemPrompt, workflows })` — bundle an AIP-42
 * agent and its AIP-15 workflows into one cross-linked, frozen handle.
 *
 * The only new invariant app-kit adds is *attachment*: the agent and its
 * bundled workflows must reference each other exactly. Everything else
 * (field validation) already ran when the caller built the handles with
 * `defineAgent` / `defineWorkflow`, so `defineApp` doesn't re-validate
 * fields — it validates the coupling.
 *
 *   - Every `agent.workflows[]` ref MUST resolve to a bundled workflow id.
 *   - Every bundled workflow MUST be referenced by `agent.workflows[]`.
 *
 * A dangling ref (agent points at a workflow it didn't bundle) or an
 * orphan (a bundled workflow the agent never lists) throws — that's what
 * "an agent attached to its workflows" means, made checkable.
 */

import { buildMastraAgent } from "@agentproto/mastra"
import type { AppDefinition, AppHandle, ToMastraAgentOptions } from "./types.js"
import { refKey } from "./refs.js"
import { emitApp } from "./emit.js"

export class AppDefinitionError extends Error {
  constructor(message: string) {
    super(`defineApp (app-kit): ${message}`)
    this.name = "AppDefinitionError"
  }
}

export function defineApp(def: AppDefinition): AppHandle {
  if (!def.agent) throw new AppDefinitionError("`agent` is required.")
  if (typeof def.systemPrompt !== "string" || def.systemPrompt.length === 0) {
    throw new AppDefinitionError(
      "`systemPrompt` is required and must be a non-empty string (it is the AGENT.md body).",
    )
  }

  const workflows = def.workflows ?? []
  validateAttachment(def.agent.id, def.agent.workflows, workflows)

  const frozenWorkflows = Object.freeze([...workflows])
  const { agent, systemPrompt } = def

  const handle: AppHandle = {
    agent,
    systemPrompt,
    workflows: frozenWorkflows,
    toMastraAgent(opts: ToMastraAgentOptions) {
      return buildMastraAgent(agent, { body: systemPrompt, ...opts })
    },
    emit(dir: string) {
      return emitApp({ agent, systemPrompt, workflows: frozenWorkflows }, dir)
    },
  }

  return Object.freeze(handle)
}

/**
 * The attachment invariant: `agent.workflows[]` refs and bundled
 * workflow ids must be the same set. External/registry workflow refs
 * are out of scope for an app bundle — if the agent lists it, the app
 * must ship it.
 */
function validateAttachment(
  agentId: string,
  agentWorkflowRefs: readonly (import("@agentproto/agent").AnyRef)[] | undefined,
  workflows: readonly import("@agentproto/workflow").WorkflowHandle[],
): void {
  const bundledIds = new Set<string>()
  for (const wf of workflows) {
    if (bundledIds.has(wf.id)) {
      throw new AppDefinitionError(
        `duplicate workflow id '${wf.id}' in the bundle.`,
      )
    }
    bundledIds.add(wf.id)
  }

  const referenced = new Set<string>()
  for (const ref of agentWorkflowRefs ?? []) {
    const key = refKey(ref)
    referenced.add(key)
    if (!bundledIds.has(key)) {
      throw new AppDefinitionError(
        `agent '${agentId}' references workflow '${key}' but the app does not bundle it. ` +
          `Bundled: [${[...bundledIds].join(", ") || "none"}].`,
      )
    }
  }

  for (const id of bundledIds) {
    if (!referenced.has(id)) {
      throw new AppDefinitionError(
        `workflow '${id}' is bundled but agent '${agentId}' does not list it in workflows[]. ` +
          `Add { ref: "${id}" } to the agent, or drop the workflow.`,
      )
    }
  }
}
