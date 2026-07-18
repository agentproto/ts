/**
 * `defineApp({ agents, workflows, attach })` — bundle one or more AIP-42
 * agents, the AIP-15 workflows they run, and any other AIP artifacts into
 * one cross-linked, frozen handle.
 *
 * The only new invariant app-kit adds is *attachment*: the agents and the
 * bundled workflows must reference each other. Everything else (field
 * validation) already ran when the caller built the handles with
 * `defineAgent` / `defineWorkflow`, so `defineApp` validates the coupling,
 * not the fields.
 *
 *   - agent ids are unique within the app.
 *   - every `agent.workflows[]` ref MUST resolve to a bundled workflow id.
 *   - every bundled workflow MUST be referenced by at least one agent.
 *
 * A dangling ref (an agent points at a workflow the app didn't bundle) or
 * an orphan (a bundled workflow no agent lists) throws — that is what "an
 * agent attached to its workflows" means, made checkable.
 */

import { buildMastraAgent } from "@agentproto/mastra"
import type { AgentHandle, AnyRef } from "@agentproto/agent"
import type { WorkflowHandle } from "@agentproto/workflow"
import type {
  AgentEntry,
  AppDefinition,
  AppHandle,
  DoctypeHandle,
  ToMastraAgentOptions,
} from "./types.js"
import { refKey } from "./refs.js"
import { emitApp } from "./emit.js"

export class AppDefinitionError extends Error {
  constructor(message: string) {
    super(`defineApp (app-kit): ${message}`)
    this.name = "AppDefinitionError"
  }
}

export function defineApp(def: AppDefinition): AppHandle {
  if (!Array.isArray(def.agents) || def.agents.length === 0) {
    throw new AppDefinitionError("`agents` must be a non-empty array.")
  }

  const agents = def.agents.map(normalizeEntry)
  const workflows = def.workflows ?? []
  const attachments = def.attach ?? []

  validateAttachment(agents, workflows)

  const frozenAgents = Object.freeze(agents.map((e) => Object.freeze({ ...e })))
  const frozenWorkflows = Object.freeze([...workflows])
  const frozenAttachments = Object.freeze([...attachments])

  const handle: AppHandle = {
    agents: frozenAgents,
    workflows: frozenWorkflows,
    attachments: frozenAttachments,

    async toMastraAgents(opts: ToMastraAgentOptions) {
      const out: Record<string, Awaited<ReturnType<typeof buildMastraAgent>>> = {}
      for (const entry of frozenAgents) {
        out[entry.agent.id] = await buildOne(entry, opts)
      }
      return out
    },

    async toMastraAgent(opts: ToMastraAgentOptions) {
      if (frozenAgents.length !== 1) {
        throw new AppDefinitionError(
          `toMastraAgent requires exactly one agent (app has ${frozenAgents.length}); use toMastraAgents.`,
        )
      }
      return buildOne(frozenAgents[0]!, opts)
    },

    emit(dir: string) {
      return emitApp({ agents: frozenAgents, workflows: frozenWorkflows }, dir)
    },
  }

  return Object.freeze(handle)
}

function buildOne(entry: AgentEntry, opts: ToMastraAgentOptions) {
  // `entry.body` (the AGENT.md body) wins as instructions; an explicit
  // `opts.body` still overrides, matching buildMastraAgent's contract.
  return buildMastraAgent(entry.agent, { body: entry.body, ...opts })
}

function normalizeEntry(input: AgentEntry | AgentHandle): AgentEntry {
  // An AgentEntry has an `.agent`; a bare AgentHandle has `.id`/`.schema`.
  if ("agent" in input) return input
  return { agent: input }
}

/**
 * The attachment invariant across all agents: bundled workflow ids and
 * the union of every agent's `workflows[]` refs must be the same set.
 * External/registry workflow refs are out of scope for an app bundle —
 * if an agent lists it, the app must ship it.
 */
function validateAttachment(
  agents: readonly AgentEntry[],
  workflows: readonly WorkflowHandle[],
): void {
  const seenAgentIds = new Set<string>()
  for (const { agent } of agents) {
    if (seenAgentIds.has(agent.id)) {
      throw new AppDefinitionError(`duplicate agent id '${agent.id}' in the bundle.`)
    }
    seenAgentIds.add(agent.id)
  }

  const bundledIds = new Set<string>()
  for (const wf of workflows) {
    if (bundledIds.has(wf.id)) {
      throw new AppDefinitionError(`duplicate workflow id '${wf.id}' in the bundle.`)
    }
    bundledIds.add(wf.id)
  }

  const referenced = new Set<string>()
  for (const { agent } of agents) {
    for (const ref of workflowRefs(agent)) {
      const key = refKey(ref)
      referenced.add(key)
      if (!bundledIds.has(key)) {
        throw new AppDefinitionError(
          `agent '${agent.id}' references workflow '${key}' but the app does not bundle it. ` +
            `Bundled: [${[...bundledIds].join(", ") || "none"}].`,
        )
      }
    }
  }

  for (const id of bundledIds) {
    if (!referenced.has(id)) {
      throw new AppDefinitionError(
        `workflow '${id}' is bundled but no agent lists it in workflows[]. ` +
          `Add { ref: "${id}" } to an agent, or drop the workflow.`,
      )
    }
  }
}

function workflowRefs(agent: AgentHandle): readonly AnyRef[] {
  return agent.workflows ?? []
}

export type { DoctypeHandle }
