/**
 * @agentproto/harness — public barrel.
 *
 * Typed, one-call agent-session presets over the agentproto daemon's session
 * tools. Connect once, then spin up `coder` / `researcher` / `supervisor`
 * sessions that all resolve to the uniform `AgentHandle` contract.
 *
 *   import { connectHarness, createCoderHarness } from "@agentproto/harness"
 *   const dx = await connectHarness()
 *   const coder = await createCoderHarness(dx, { workspace: process.cwd() })
 *   const reply = await coder.ask("Add a health-check route")
 */

import { HarnessClient } from "./client.js"
import type { ConnectHarnessOptions } from "./types.js"

/**
 * Connect the shared transport to the daemon's `/mcp` endpoint. Returns a
 * `HarnessClient` to hand to the `create*Harness` factories.
 */
export async function connectHarness(
  opts?: ConnectHarnessOptions,
): Promise<HarnessClient> {
  return HarnessClient.connect(opts)
}

export { HarnessClient, DEFAULT_MCP_URL, resolveMcpUrl } from "./client.js"
export { makeHandle } from "./handle.js"

export {
  createCoderHarness,
  buildCoderArgs,
  renderCoderPrompt,
  type CoderHarnessOptions,
} from "./harnesses/coder.js"
export {
  createResearcherHarness,
  buildResearcherArgs,
  renderResearcherPrompt,
  DEFAULT_RESEARCH_SCHEMA,
  type ResearcherHarnessOptions,
} from "./harnesses/researcher.js"
export {
  createSupervisorHarness,
  buildSupervisorArgs,
  renderSupervisorPrompt,
  type SupervisorHarnessOptions,
  type SupervisorHandle,
} from "./harnesses/supervisor.js"

export type {
  AgentHandle,
  TurnResult,
  TurnEvent,
  McpServerMount,
  OrchestratorOption,
  StartAgentArgs,
  SessionDescriptor,
  ConnectHarnessOptions,
  CoderContext,
  WorkPackage,
} from "./types.js"
