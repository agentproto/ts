/**
 * Types for `@agentproto/app-kit`.
 *
 * An "app" is the smallest shippable unit that couples one or more AIP-42
 * agents with the AIP-15 workflows they run — plus any other AIP artifacts
 * you want to ride along (an AIP-6 company, AIP-25 personas, AIP-47 roles,
 * policies…). The agents and workflows are authored with the existing
 * `defineAgent` / `defineWorkflow`; app-kit bundles + cross-links them.
 *
 * On the system prompt: there is no `systemPrompt` field anywhere in AIP.
 * The prompt is the free-text BODY of an AGENT.md (AIP-42) — frontmatter is
 * `.strict()` and holds only metadata. So each agent carries an optional
 * `body`; when omitted the prompt composes from the agent's persona /
 * boundaries / traits (`composeInstructions` falls back to `description`),
 * the same way Guilde assembles an operator's prompt from AIP-47 role
 * instructions + AIP-25 persona rather than a stored string.
 */

import type { AgentHandle } from "@agentproto/agent"
import type { WorkflowHandle } from "@agentproto/workflow"
import type { BuildMastraAgentResult, BuildMastraAgentOptions } from "@agentproto/mastra"

/**
 * An agent paired with the prose that becomes its system prompt. `body`
 * is the AGENT.md body (AIP-42) — the only place free-text instructions
 * live. Optional: omit it to let the prompt compose from the agent's
 * structured fields.
 */
export interface AgentEntry {
  readonly agent: AgentHandle
  /** The AGENT.md body / system prompt. Optional — composed if absent. */
  readonly body?: string
}

/**
 * Structural view of any AIP doctype handle (agent, company, persona,
 * role, policy…). Every `defineX` handle has a stable `id`; `schema`
 * carries the doctype literal when the doctype declares one. Kept
 * structural so an app can `attach` any AIP artifact without app-kit
 * depending on each doctype package.
 */
export interface DoctypeHandle {
  readonly id: string
  readonly schema?: string
}

/**
 * Input to `defineApp`. Each `agents[]` entry is an already-validated
 * `AgentHandle` (bare, no body) or an `AgentEntry` (handle + body).
 */
export interface AppDefinition {
  readonly agents: readonly (AgentEntry | AgentHandle)[]
  readonly workflows?: readonly WorkflowHandle[]
  /** Any other AIP handles to carry with the app (AIP-6/25/47/…). */
  readonly attach?: readonly DoctypeHandle[]
}

/** Options for `toMastraAgent(s)`. Same resolvers as `buildMastraAgent`. */
export type ToMastraAgentOptions = BuildMastraAgentOptions

/** Paths written by `AppHandle.emit`. */
export interface EmittedApp {
  /** Absolute paths to the written `AGENT.md` files, keyed by agent id. */
  readonly agentPaths: Readonly<Record<string, string>>
  /** Absolute paths to the written `WORKFLOW.md` files, in input order. */
  readonly workflowPaths: readonly string[]
}

/**
 * The frozen result of `defineApp`. Carries the cross-linked agents +
 * workflows + attachments and the two consumption paths.
 */
export interface AppHandle {
  readonly agents: readonly AgentEntry[]
  readonly workflows: readonly WorkflowHandle[]
  readonly attachments: readonly DoctypeHandle[]

  /**
   * Build every agent into a runnable Mastra agent whose `instructions`
   * field is the real system prompt (body → `composeInstructions`).
   * Keyed by agent id.
   */
  toMastraAgents(
    opts: ToMastraAgentOptions,
  ): Promise<Record<string, BuildMastraAgentResult>>

  /**
   * Single-agent convenience. Throws if the app has zero or more than
   * one agent — use `toMastraAgents` for multi-agent apps.
   */
  toMastraAgent(opts: ToMastraAgentOptions): Promise<BuildMastraAgentResult>

  /**
   * Write one `AGENT.md` per agent + one shared `WORKFLOW.md` per
   * workflow under `dir`, in the layout the daemon / `agentproto-run`
   * lane load. Returns the written paths.
   */
  emit(dir: string): Promise<EmittedApp>
}
