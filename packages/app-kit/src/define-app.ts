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
import { defineWorkspace } from "@agentproto/workspace"
import type { AgentHandle, AnyRef } from "@agentproto/agent"
import type { WorkflowHandle } from "@agentproto/workflow"
import type { WorkspaceHandle } from "@agentproto/workspace"
import type {
  AgentEntry,
  AppDefinition,
  AppHandle,
  DoctypeHandle,
  ToMastraAgentOptions,
  WorkspaceInput,
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
  if (def.id !== undefined && def.id.trim() === "") {
    throw new AppDefinitionError("`id` must be non-empty when present.")
  }
  if (def.ui !== undefined && (typeof def.ui.html !== "string" || def.ui.html.trim() === "")) {
    throw new AppDefinitionError("`ui.html` must be a non-empty string when `ui` is present.")
  }
  if (def.dev !== undefined && (!Array.isArray(def.dev.launch) || def.dev.launch.length === 0)) {
    throw new AppDefinitionError("`dev.launch` must be a non-empty array when `dev` is present.")
  }
if (def.artifact !== undefined && (typeof def.artifact.path !== "string" || def.artifact.path.trim() === "")) {
    throw new AppDefinitionError("`artifact.path` must be a non-empty string when `artifact` is present.")
  }
  if (def.skill !== undefined && (typeof def.skill.path !== "string" || def.skill.path.trim() === "")) {
    throw new AppDefinitionError("`skill.path` must be a non-empty string when `skill` is present.")
  }

  const agents = def.agents.map(normalizeEntry)
  const workflows = def.workflows ?? []
  const attachments = def.attach ?? []
  const workspace = def.workspace ? toWorkspaceHandle(def.workspace) : undefined
  const id = def.id
  const name = def.name
  const version = def.version ?? (id ? "0.1.0" : undefined)
  const description = def.description
  const requires = def.requires ? Object.freeze([...def.requires]) : undefined
  const ui = def.ui ? Object.freeze({ ...def.ui }) : undefined
  const artifact = def.artifact ? Object.freeze({ ...def.artifact }) : undefined
  const skill = def.skill ? Object.freeze({ ...def.skill }) : undefined
  const artifacts = def.artifacts ? Object.freeze(def.artifacts.map(a => Object.freeze({ ...a }))) : undefined
  const dev = def.dev
    ? Object.freeze({ launch: Object.freeze(def.dev.launch.map(l => Object.freeze({ ...l }))) })
    : undefined
  const externalReadRoots = def.externalReadRoots ? Object.freeze([...def.externalReadRoots]) : undefined

  validateAttachment(agents, workflows)

  const frozenAgents = Object.freeze(agents.map((e) => Object.freeze({ ...e })))
  const frozenWorkflows = Object.freeze([...workflows])
  const frozenAttachments = Object.freeze([...attachments])

  const handle: AppHandle = {
    agents: frozenAgents,
    workflows: frozenWorkflows,
    attachments: frozenAttachments,
    ...(workspace ? { workspace } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(requires !== undefined ? { requires } : {}),
    ...(ui !== undefined ? { ui } : {}),
    ...(artifact !== undefined ? { artifact } : {}),
    ...(skill !== undefined ? { skill } : {}),
    ...(artifacts !== undefined ? { artifacts } : {}),
    ...(dev !== undefined ? { dev } : {}),
    ...(externalReadRoots !== undefined ? { externalReadRoots } : {}),

    async toMastraAgents(opts: ToMastraAgentOptions, only?: readonly string[]) {
      const targets = only ? selectAgents(frozenAgents, only) : frozenAgents
      const out: Record<string, Awaited<ReturnType<typeof buildMastraAgent>>> = {}
      for (const entry of targets) {
        out[entry.agent.id] = await buildOne(entry, opts)
      }
      return out
    },

    pick(ids: readonly string[]) {
      return selectAgents(frozenAgents, ids)
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
      return emitApp(
        {
          agents: frozenAgents,
          workflows: frozenWorkflows,
          ...(workspace ? { workspace } : {}),
          ...(id !== undefined ? { id } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(version !== undefined ? { version } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(requires !== undefined ? { requires } : {}),
          ...(ui !== undefined ? { ui } : {}),
          ...(artifact !== undefined ? { artifact } : {}),
          ...(skill !== undefined ? { skill } : {}),
          ...(artifacts !== undefined ? { artifacts } : {}),
          ...(dev !== undefined ? { dev } : {}),
          ...(externalReadRoots !== undefined ? { externalReadRoots } : {}),
        },
        dir,
      )
    },
  }

  return Object.freeze(handle)
}

/**
 * Normalize the `workspace` input to an AIP-34 `WorkspaceHandle`. A built
 * handle (already run through `defineWorkspace`) carries `schema:
 * "workspace/v1"` and passes straight through; a `WorkspaceShorthand` is
 * completed with a local-fs storage default and a `0.1.0` version, then
 * validated by `defineWorkspace` — so a malformed shorthand fails with the
 * same AIP-34 diagnostic as a malformed WORKSPACE.md.
 */
function toWorkspaceHandle(input: WorkspaceInput): WorkspaceHandle {
  if ("schema" in input) return input
  return defineWorkspace({
    schema: "workspace/v1",
    version: input.version ?? "0.1.0",
    id: input.id,
    name: input.name,
    owner: input.owner,
    storage: input.storage ?? { inline: { provider: "local-fs", config: {} } },
    ...(input.description ? { description: input.description } : {}),
  })
}

/**
 * Resolve `ids` to their app entries, preserving the caller's order. Throws
 * `AppDefinitionError` on any id the app doesn't bundle — a hand-picked list
 * that names a missing agent is a bug, not a silent no-op.
 */
function selectAgents(
  agents: readonly AgentEntry[],
  ids: readonly string[],
): readonly AgentEntry[] {
  const byId = new Map(agents.map((e) => [e.agent.id, e]))
  return ids.map((id) => {
    const entry = byId.get(id)
    if (!entry) {
      throw new AppDefinitionError(
        `agent '${id}' is not in this app. Bundled: [${[...byId.keys()].join(", ")}].`,
      )
    }
    return entry
  })
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
