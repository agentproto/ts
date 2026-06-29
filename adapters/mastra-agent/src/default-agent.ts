/**
 * Builds a runnable Mastra agent from an AIP-42 AGENT.md — either a caller's
 * file or a zero-config built-in default. This is the factory the ACP host
 * lazily invokes on first prompt.
 */

import { readFile } from "node:fs/promises"
import { agentFromManifest, parseAgentManifest } from "@agentproto/agent"
import { buildMastraAgent } from "@agentproto/mastra"
import type { MastraLike } from "./acp-host.js"
import { resolveMastraModel } from "./model-resolver.js"

/** Cheap OpenRouter coder by default — this is the budget first-party arm,
 *  same rationale as the hermes default. Override with --model / env. */
export const DEFAULT_MODEL = "openrouter/z-ai/glm-5.2"

export interface AgentSourceOptions {
  /** Path to an AGENT.md. When omitted, the built-in default agent is used. */
  agentFile?: string
  /** Model id for the default agent (ignored when agentFile carries a model). */
  model?: string
}

/** The built-in AGENT.md used when no file is supplied. */
export function defaultAgentManifest(model: string): string {
  return [
    "---",
    "schema: agent/v1",
    "id: mastra-agent",
    "description: A first-party agentproto agent powered by Mastra.",
    `model: ${model}`,
    "version: 0.1.0",
    "---",
    "",
    "You are a helpful, concise agent. Do exactly what the user asks, ",
    "nothing more. When asked to reply with an exact string, reply with ",
    "only that string.",
    "",
  ].join("\n")
}

/** Resolve the AGENT.md source for these options (file or built-in default). */
export async function resolveAgentSource(
  opts: AgentSourceOptions = {},
): Promise<string> {
  if (opts.agentFile) return readFile(opts.agentFile, "utf8")
  return defaultAgentManifest(opts.model ?? DEFAULT_MODEL)
}

/**
 * A lazy factory: parses the AGENT.md, builds the Mastra agent with our model
 * resolver, and returns it as the structural `MastraLike` the ACP host needs.
 */
export function makeAgentFactory(
  opts: AgentSourceOptions = {},
): () => Promise<MastraLike> {
  return async () => {
    const source = await resolveAgentSource(opts)
    const handle = agentFromManifest(parseAgentManifest(source))
    const { agent } = await buildMastraAgent(handle, {
      resolveModel: (ref) => resolveMastraModel(ref),
    })
    return agent as unknown as MastraLike
  }
}
