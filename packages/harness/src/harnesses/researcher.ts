/**
 * @agentproto/harness — researcher preset (WP4).
 *
 * Spawns a big-context research agent: `hermes` routed to GLM-5.2 via
 * OpenRouter. Mounts a web-search MCP server and injects a structured-output
 * instruction so replies are parseable.
 */

import type { HarnessClient } from "../client.js"
import { makeHandle } from "../handle.js"
import type {
  AgentHandle,
  McpServerMount,
  StartAgentArgs,
} from "../types.js"

export interface ResearcherHarnessOptions {
  /** Model override. Default `z-ai/glm-5.2` (big context, WP6). */
  model?: string
  cwd?: string
  workspaceSlug?: string
  /** MCP server to mount for web search (e.g. a bureau/search MCP ref). */
  searchMcp?: McpServerMount
  /** JSON schema hint injected into the spawn prompt for structured output. */
  outputSchema?: Record<string, unknown>
  effort?: string
  label?: string
  mcpServers?: McpServerMount[]
}

const DEFAULTS = {
  model: "z-ai/glm-5.2",
} as const

/** Default output-schema hint the researcher is asked to return. */
export const DEFAULT_RESEARCH_SCHEMA = {
  findings: "string[]",
  sources: "string[]",
  confidence: "low | medium | high",
} as const

/**
 * Render the researcher spawn prompt — an instruction block telling the agent:
 * 1. It is a researcher agent.
 * 2. It MUST structure its final answer as JSON matching the outputSchema.
 * 3. Brief format hint: { findings: [...], sources: [...], confidence: "..." }
 *
 * Exported for unit tests.
 */
export function renderResearcherPrompt(
  opts: ResearcherHarnessOptions,
): string {
  const schema = opts.outputSchema ?? DEFAULT_RESEARCH_SCHEMA
  return [
    "You are a researcher agent. Use the available web-search tools to gather",
    "evidence and synthesize findings.",
    "",
    "You MUST structure your final answer as JSON matching this schema:",
    JSON.stringify(schema, null, 2),
    "",
    "Format hint:",
    "  {",
    '    "findings": ["key finding 1", "key finding 2", ...],',
    '    "sources": ["url or citation", ...],',
    '    "confidence": "low | medium | high"',
    "  }",
  ].join("\n")
}

/**
 * Build the `start_agent_session` args for the researcher preset.
 * Exported so WP4's unit test can assert `mcpServers` + schema are present.
 */
export function buildResearcherArgs(
  opts: ResearcherHarnessOptions,
): StartAgentArgs {
  const mcpServers: McpServerMount[] = [
    ...(opts.mcpServers ?? []),
    ...(opts.searchMcp ? [opts.searchMcp] : []),
  ]
  return {
    adapter: "hermes",
    model: opts.model ?? DEFAULTS.model,
    prompt: renderResearcherPrompt(opts),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.workspaceSlug ? { workspaceSlug: opts.workspaceSlug } : {}),
    ...(mcpServers.length ? { mcpServers } : {}),
    ...(opts.label ? { label: opts.label } : {}),
  }
}

/** Create a researcher session and return its handle. */
export async function createResearcherHarness(
  client: HarnessClient,
  opts: ResearcherHarnessOptions = {},
): Promise<AgentHandle> {
  const args = buildResearcherArgs(opts)
  const desc = await client.start(args)
  return makeHandle(client, {
    sessionId: desc.id,
    adapter: args.adapter,
    ...(args.model ? { model: args.model } : {}),
  })
}