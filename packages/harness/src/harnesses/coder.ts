/**
 * @agentproto/harness — coder preset (WP3, STUB).
 *
 * Spawns a coding agent: `claude-code` (default) or `hermes` routed to a coding
 * model via OpenRouter. Sets cwd to the workspace and injects a coding context
 * (stack, conventions, gate commands) as the initial prompt.
 */

import type { HarnessClient } from "../client.js"
import { renderCoderPrompt } from "../context.js"
export { renderCoderPrompt }
import type { CoderContext } from "../context.js"
import { makeHandle } from "../handle.js"
import type {
  AgentHandle,
  McpServerMount,
  StartAgentArgs,
} from "../types.js"

export interface CoderHarnessOptions {
  /** Absolute workspace path (wins over `workspaceSlug`). */
  workspace?: string
  workspaceSlug?: string
  /** Engine selector. Default `claude-code`. */
  engine?: "claude-code" | "hermes"
  /** Model override. Defaults: claude-code → `claude-opus-4-8`;
   *  hermes → `deepseek/deepseek-v4-pro` (confirmed live, WP6). */
  model?: string
  /** Reasoning effort. Default `high`. */
  effort?: string
  /** Coding context rendered into the spawn prompt. */
  context?: CoderContext
  label?: string
  mcpServers?: McpServerMount[]
}

const DEFAULTS = {
  claudeCodeModel: "claude-opus-4-8",
  hermesModel: "deepseek/deepseek-v4-pro",
  effort: "high",
} as const

/**
 * Build the `agent_start` args for the coder preset. Exported so WP3's
 * unit test can snapshot the args for both engines without a live daemon.
 *
 * For hermes: `model` and `effort` are NOT included — hermes does not declare
 * them as manifest options so the daemon rejects them at compose time. Instead,
 * `createCoderHarness` sends `/model <slug>` as a first prompt turn after spawn.
 */
export function buildCoderArgs(opts: CoderHarnessOptions): StartAgentArgs {
  const engine = opts.engine ?? "claude-code"
  const isHermes = engine === "hermes"
  const model =
    opts.model ??
    (isHermes ? DEFAULTS.hermesModel : DEFAULTS.claudeCodeModel)
  return {
    adapter: engine,
    ...(isHermes ? {} : { model, effort: opts.effort ?? DEFAULTS.effort }),
    ...(opts.workspace ? { cwd: opts.workspace } : {}),
    ...(opts.workspaceSlug ? { workspaceSlug: opts.workspaceSlug } : {}),
    ...(opts.context ? { prompt: renderCoderPrompt(opts.context) } : {}),
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
  }
}

/** Create a coder session and return its handle. */
export async function createCoderHarness(
  client: HarnessClient,
  opts: CoderHarnessOptions = {},
): Promise<AgentHandle> {
  const engine = opts.engine ?? "claude-code"
  const isHermes = engine === "hermes"
  const modelSlug = isHermes
    ? (opts.model ?? DEFAULTS.hermesModel)
    : (opts.model ?? DEFAULTS.claudeCodeModel)
  const args = buildCoderArgs(opts)
  const desc = await client.start(args)
  if (isHermes && modelSlug) {
    await client.prompt(desc.id, `/model ${modelSlug}`)
    // wait for the model-switch turn to complete before caller uses the handle,
    // otherwise waitForTurn() on the first ask() triggers on this event instead
    await client.waitForAny([desc.id], { event: "turn-end", timeoutMs: 15_000 })
  }
  return makeHandle(client, {
    sessionId: desc.id,
    adapter: args.adapter,
    model: modelSlug,
  })
}
