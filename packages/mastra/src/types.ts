/**
 * Resolver and option types used by `buildMastraAgent`.
 *
 * The package never bakes in a model provider, a tool registry, or a
 * memory backend — those are runtime concerns the host owns. We expose
 * the manifest fields as ref values and let the host translate.
 */

import type { Agent } from "@mastra/core/agent"
import type {
  AgentHandle,
  AnyRef,
  ActionRef,
  ModelRef,
  MemoryConfig,
} from "@agentproto/agent"

// Mastra's Agent ctor surfaces these via its internal types but they're
// not re-exported in a stable form, so we widen to `unknown` at the
// boundary and let the host narrow with its own model/tool/memory types.
// Same trick `@agentproto/manifest` uses with DoctypeSpec — keep the
// generic surface flat, push type-tightening to the call site.
export type LanguageModelLike = unknown
export type MastraToolLike = unknown
export type MastraMemoryLike = unknown
export type MastraVoiceLike = unknown
export type MastraWorkflowLike = unknown

/**
 * Resolves an AIP-42 `model:` ref to whatever the host's `new Agent`
 * constructor accepts as `model`. Throws if the ref can't be resolved.
 */
export type ModelResolver = (
  ref: ModelRef,
) => LanguageModelLike | Promise<LanguageModelLike>

/**
 * Resolves a tool ref. Returning `undefined` skips the tool (with a
 * warning) — useful when the host's tool catalog is partial. The
 * returned tool name is taken from the ref string when available;
 * structured refs should set `id` on the tool itself.
 */
export type ToolResolver = (
  ref: AnyRef,
) =>
  | { name: string; tool: MastraToolLike }
  | undefined
  | Promise<{ name: string; tool: MastraToolLike } | undefined>

/**
 * Resolves a workflow ref. Workflows aren't passed to `new Agent`
 * directly in Mastra — they're registered on the Mastra instance —
 * but the resolver is invoked here so the host can validate that
 * every `workflows[]` entry on the manifest exists in the registry.
 */
export type WorkflowResolver = (
  ref: AnyRef,
) =>
  | { name: string; workflow: MastraWorkflowLike }
  | undefined
  | Promise<{ name: string; workflow: MastraWorkflowLike } | undefined>

/**
 * Builds a Mastra `Memory` instance from the manifest's `memory:`
 * block. Return `undefined` to attach no memory (Mastra default).
 */
export type MemoryBuilder = (
  config: MemoryConfig,
) => MastraMemoryLike | undefined | Promise<MastraMemoryLike | undefined>

/**
 * Builds a voice provider for runtime voice/audio agents. Optional;
 * only invoked when the host opts in via `withVoice`.
 */
export type VoiceBuilder = (
  handle: AgentHandle,
) => MastraVoiceLike | undefined | Promise<MastraVoiceLike | undefined>

/**
 * Composes the system prompt the agent runs under. Defaults to
 * `composeInstructions(handle, body)` from `./instructions.ts`.
 */
export type InstructionsFormatter = (
  handle: AgentHandle,
  body: string | undefined,
) => string

export interface BuildMastraAgentOptions {
  /** Required. Maps `model:` to a Mastra-compatible LanguageModel. */
  resolveModel: ModelResolver
  /** Optional. Without it, `tools[]` is dropped with a console.warn. */
  resolveTool?: ToolResolver
  /** Optional. Validates that workflows exist; result not attached to Agent. */
  resolveWorkflow?: WorkflowResolver
  /** Optional. Attaches Mastra Memory to the Agent. */
  buildMemory?: MemoryBuilder
  /** Optional. Attaches a voice provider (ElevenLabs etc.) to the Agent. */
  buildVoice?: VoiceBuilder
  /** Optional. Override how AGENT.md body + boundaries become instructions. */
  formatInstructions?: InstructionsFormatter
  /**
   * Optional. The markdown body of the AGENT.md (everything after
   * frontmatter). When absent, instructions fall back to `description`.
   */
  body?: string
  /**
   * Optional. Override the agent's display name. Defaults to
   * `handle.id` (with the `@<owner>/` prefix stripped).
   */
  name?: string
  /**
   * Optional. Override the agent's stable id. Defaults to `handle.id`.
   */
  id?: string
  /**
   * Optional. If a tool ref can't be resolved, throw instead of
   * silently dropping. Defaults to `false` (warn + drop).
   */
  strict?: boolean
}

/**
 * Result of `buildMastraAgent`. Returns the Agent + diagnostics about
 * what got resolved vs dropped, useful for tests and surface UIs.
 */
export interface BuildMastraAgentResult {
  agent: Agent
  /** Tool refs that resolved successfully (by name). */
  resolvedTools: string[]
  /** Tool refs that the resolver returned `undefined` for. */
  droppedTools: string[]
  /** Workflow refs that resolved successfully. */
  resolvedWorkflows: string[]
  /** Workflow refs that the resolver returned `undefined` for. */
  droppedWorkflows: string[]
  /** The composed instructions string. */
  instructions: string
}

export type {
  AgentHandle,
  AnyRef,
  ActionRef,
  ModelRef,
  MemoryConfig,
}
