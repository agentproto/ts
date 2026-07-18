/**
 * Types for `@agentproto/app-kit`.
 *
 * An "app" is the smallest shippable unit that couples an AIP-42 agent
 * (its system prompt included) with the AIP-15 workflows it runs. The
 * agent and workflows are authored with the existing `defineAgent` /
 * `defineWorkflow` — app-kit only bundles + cross-links them and gives
 * you two ways out: a runnable Mastra agent, or emitted manifests.
 */

import type { AgentHandle } from "@agentproto/agent"
import type { WorkflowHandle } from "@agentproto/workflow"
import type { BuildMastraAgentOptions } from "@agentproto/mastra"

/**
 * Input to `defineApp`. `agent` and each `workflows[]` entry are
 * already-validated handles from `defineAgent` / `defineWorkflow`.
 * `systemPrompt` is the AGENT.md body (AIP-42: the body is the system
 * prompt) — carried explicitly because there is no `.md` file in the
 * TS-authoring path to read it from.
 */
export interface AppDefinition {
  readonly agent: AgentHandle
  /** The AGENT.md body / system prompt. */
  readonly systemPrompt: string
  readonly workflows?: readonly WorkflowHandle[]
}

/**
 * Options for `AppHandle.toMastraAgent`. Same resolvers as
 * `buildMastraAgent`, minus `body` — app-kit injects `systemPrompt`
 * as the body (pass `body` here only to override it).
 */
export type ToMastraAgentOptions = BuildMastraAgentOptions

/** Paths written by `AppHandle.emit`. */
export interface EmittedApp {
  /** Absolute path to the written `.agents/<id>/AGENT.md`. */
  readonly agentPath: string
  /** Absolute paths to the written `WORKFLOW.md` files, in input order. */
  readonly workflowPaths: readonly string[]
}

/**
 * The frozen result of `defineApp`. Carries the cross-linked agent +
 * workflows and the two consumption paths.
 */
export interface AppHandle {
  readonly agent: AgentHandle
  readonly systemPrompt: string
  readonly workflows: readonly WorkflowHandle[]

  /**
   * Build a runnable Mastra agent whose `instructions` field is the
   * real system prompt (AGENT.md body → `composeInstructions`). Thin
   * wrap of `buildMastraAgent(agent, { body: systemPrompt, ...opts })`.
   */
  toMastraAgent(
    opts: ToMastraAgentOptions,
  ): ReturnType<typeof import("@agentproto/mastra").buildMastraAgent>

  /**
   * Write `.agents/<id>/AGENT.md` + one `WORKFLOW.md` per workflow
   * under `dir`, in the layout the daemon / `agentproto-run` lane
   * loads. Returns the written paths.
   */
  emit(dir: string): Promise<EmittedApp>
}
