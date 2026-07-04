/**
 * Build the Claude Agent SDK `Options` for a turn, and map ACP-side inputs
 * (session id, injected MCP servers) onto it. Isolated from the ACP host so
 * the option-shaping is unit-testable without a live SDK.
 */

import type { McpServer } from "@agentclientprotocol/sdk"
import type {
  McpServerConfig,
  Options,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk"

/** A cheap Claude by default — this is a budget first-party arm. */
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001"

/** Static config for the adapter, parsed from CLI args / env at boot. */
export interface ClaudeSdkConfig {
  /** SDK `options.model`. Defaults to {@link DEFAULT_MODEL}. */
  model?: string
  /** Sets `ANTHROPIC_BASE_URL` in the child env — points the harness at real
   *  Anthropic, Bedrock/Vertex/Azure, or an Anthropic-compatible gateway. */
  baseUrl?: string
  /** Sets `ANTHROPIC_AUTH_TOKEN` in the child env — the SDK sends it as
   *  `Authorization: Bearer`. Pair with {@link baseUrl} to target a gateway
   *  (Moonshot / OpenRouter) with a per-spawn key instead of the ambient
   *  `ANTHROPIC_API_KEY`. Never logged. */
  authToken?: string
  /**
   * Enable extended thinking (SDK `options.thinking = { type: "enabled" }`).
   * Required by some gateway models (e.g. Moonshot's `kimi-k2.7-code`, which
   * rejects a request without it). Off by default — native Claude models pick
   * their own thinking behaviour.
   */
  thinking?: boolean
  /** Working directory for the session (tools are confined here). */
  cwd?: string
  /**
   * How the harness handles tool-permission prompts. Defaults to
   * `bypassPermissions` (with the required danger flag) so the arm can act
   * autonomously inside the daemon's sandbox, mirroring how the claude-code
   * arm is spawned. Override via `CLAUDE_SDK_PERMISSION_MODE`.
   */
  permissionMode?: PermissionMode
}

/**
 * Map ACP `session/new` MCP server declarations to the SDK's
 * `mcpServers` record (keyed by name). Lets the daemon inject a scoped toolset
 * into the harness exactly like any other arm. Env pairs / headers arrive as
 * `{ name, value }` lists on the wire; flatten them to the record shape the
 * SDK expects.
 */
export function mapAcpMcpServers(
  servers: McpServer[] | undefined,
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  for (const server of servers ?? []) {
    if ("type" in server && server.type === "http") {
      out[server.name] = {
        type: "http",
        url: server.url,
        headers: flattenPairs(server.headers),
      }
    } else if ("type" in server && server.type === "sse") {
      out[server.name] = {
        type: "sse",
        url: server.url,
        headers: flattenPairs(server.headers),
      }
    } else {
      // Stdio is the default (untagged) ACP MCP variant.
      out[server.name] = {
        type: "stdio",
        command: server.command,
        args: server.args,
        env: flattenPairs(server.env),
      }
    }
  }
  return out
}

/** Flatten an ACP `{ name, value }[]` list to a `Record<string, string>`. */
function flattenPairs(
  pairs: Array<{ name: string; value: string }> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of pairs ?? []) out[pair.name] = pair.value
  return out
}

/**
 * Assemble the SDK `Options` for a single `query()` call.
 *
 * - `sessionId` pins a stable UUID on the FIRST turn so the ACP session id and
 *   the SDK session id match (enabling resume).
 * - `resume` continues that same session on later turns.
 * - `base_url` is injected as `ANTHROPIC_BASE_URL`, `auth_token` as
 *   `ANTHROPIC_AUTH_TOKEN` (sent by the SDK as `Authorization: Bearer`); the
 *   rest of `process.env` (`CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`,
 *   `ANTHROPIC_API_KEY`) is passed through unchanged.
 * - When `base_url` is set (gateway mode), every internal model tier is pinned
 *   to the resolved model so a single-model gateway never receives a request
 *   for a tier it can't serve (e.g. Moonshot rejecting `claude-haiku-*`).
 *   Native mode (no `base_url`) leaves tier routing untouched.
 */
export function buildQueryOptions(args: {
  config: ClaudeSdkConfig
  abortController: AbortController
  /** Set on the first turn to fix the session UUID. */
  sessionId?: string
  /** Set on resuming turns. */
  resume?: string
  mcpServers?: McpServer[]
  env?: Record<string, string | undefined>
}): Options {
  const { config, abortController, sessionId, resume, mcpServers } = args
  const model = config.model ?? DEFAULT_MODEL
  const baseEnv = args.env ?? process.env
  const env: Record<string, string | undefined> = { ...baseEnv }
  if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl
  if (config.authToken) env.ANTHROPIC_AUTH_TOKEN = config.authToken
  // Gateway mode: pin every tier the harness might request (opus/sonnet/haiku
  // defaults + the small/fast background model) to the one model the gateway
  // serves. Only when a custom base_url is set — native Anthropic is left to
  // route tiers itself.
  if (config.baseUrl) {
    env.ANTHROPIC_MODEL = model
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model
    env.ANTHROPIC_SMALL_FAST_MODEL = model
  }

  const options: Options = {
    model,
    abortController,
    permissionMode: config.permissionMode ?? "bypassPermissions",
    // Required companion to bypassPermissions — this arm runs unattended.
    allowDangerouslySkipPermissions: true,
    // Hermetic embed: don't silently pull in filesystem settings / CLAUDE.md;
    // the daemon owns the configuration surface.
    settingSources: [],
    env,
    ...(config.cwd ? { cwd: config.cwd } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(resume ? { resume } : {}),
  }
  // Extended thinking, opt-in. Required by thinking-gated gateway models such
  // as kimi-k2.7-code (rejects a request with no `thinking`). The property's
  // type contextualises the literal, so no cast is needed.
  if (config.thinking) options.thinking = { type: "enabled" }
  const mapped = mapAcpMcpServers(mcpServers)
  if (Object.keys(mapped).length > 0) options.mcpServers = mapped
  return options
}
