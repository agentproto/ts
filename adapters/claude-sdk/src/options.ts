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

/**
 * Default idle watchdog for a turn (ms). If `query()` yields no message for
 * this long, {@link ClaudeSdkConfig.idleTimeoutMs} aborts the turn instead of
 * hanging forever. Ninety seconds: the watchdog is IDLE-based (reset on every
 * SDK message), and a healthy streaming turn — native or gateway — emits
 * messages continuously with sub-second gaps, so a 90s silence means the SDK
 * child is genuinely wedged. The prior 5-minute ceiling was needlessly slow to
 * surface a wedged child; 90s stays well clear of any real inter-message gap
 * while turning a wedged turn around quickly. `0` disables. See
 * {@link ClaudeSdkConfig.idleTimeoutMs}.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 90_000

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
   * Idle watchdog for a turn, in milliseconds. If the SDK's `query()` iterator
   * produces no message for this long, the turn is aborted with a surfaced
   * error instead of hanging forever. This is a defensive guard against a
   * wedged SDK child — one that stops yielding messages and never delivers the
   * SDK's terminal `result`, nor closes — which would otherwise leave the turn
   * stuck `busy` with zero output (the worst failure mode). The observed cause
   * is environmental, NOT the model or its response shape: a conflicting host
   * env leaking into the spawned SDK subprocess (e.g. a stray
   * `ANTHROPIC_BASE_URL`, or a `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX` auth toggle
   * inherited from a Claude Code shell) can send the child down a path that
   * never completes. Moonshot's own Anthropic-compatible responses (empty
   * `thinking.signature`, a non-`msg_` `chatcmpl-…` id, a `message_delta`-
   * terminated stream) are consumed and finalised correctly by the SDK —
   * verified live end-to-end under a clean env — so the guard is a safety net
   * for a wedged child, not a gateway/response defect. Idle-based (reset on
   * every message), so a legitimately long generation or tool run is
   * unaffected. `0` disables the watchdog. Defaults to
   * {@link DEFAULT_IDLE_TIMEOUT_MS}. Overridable at the CLI via
   * `CLAUDE_SDK_IDLE_TIMEOUT_MS`.
   */
  idleTimeoutMs?: number
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
 * - Native mode (no `base_url`): the ambient env — `ANTHROPIC_API_KEY` or the
 *   Claude Code subscription/OAuth login — is passed through unchanged; an
 *   explicit `auth_token` still wins as `ANTHROPIC_AUTH_TOKEN`.
 * - Gateway mode (`base_url` set → a non-Anthropic host): the ambient
 *   `ANTHROPIC_API_KEY` is SCRUBBED (it must never be sent to a third-party
 *   gateway — that both 401s and leaks the real key). The gateway bearer is
 *   resolved from, in order, the explicit `auth_token`, an explicit
 *   `ANTHROPIC_AUTH_TOKEN`, or the gateway's conventional key env named by the
 *   mode via `CLAUDE_SDK_GATEWAY_KEY_ENV` (e.g. `MOONSHOT_API_KEY`). Every
 *   internal model tier is also pinned to the resolved model so a single-model
 *   gateway never gets a tier it can't serve (e.g. Moonshot rejecting
 *   `claude-haiku-*`).
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
  if (config.baseUrl) {
    // Gateway mode (non-Anthropic host). Auth hygiene: an ambient
    // ANTHROPIC_API_KEY must NEVER reach a third-party gateway (it 401s AND
    // leaks the real Anthropic key). Resolve the gateway bearer from, in order,
    // the explicit auth_token, an explicit ANTHROPIC_AUTH_TOKEN, or the
    // gateway's conventional key env named by the mode via
    // CLAUDE_SDK_GATEWAY_KEY_ENV (e.g. MOONSHOT_API_KEY). Then scrub the
    // Anthropic key so exactly the gateway's own credential is presented; if
    // none resolves, present no credential (fail clean, never leak).
    env.ANTHROPIC_BASE_URL = config.baseUrl
    const gatewayKeyEnv = baseEnv.CLAUDE_SDK_GATEWAY_KEY_ENV
    const bearer =
      config.authToken ??
      baseEnv.ANTHROPIC_AUTH_TOKEN ??
      (gatewayKeyEnv ? baseEnv[gatewayKeyEnv] : undefined)
    delete env.ANTHROPIC_API_KEY
    if (bearer) env.ANTHROPIC_AUTH_TOKEN = bearer
    else delete env.ANTHROPIC_AUTH_TOKEN
    // Pin every tier the harness might request (opus/sonnet/haiku defaults + the
    // small/fast background model) to the one model the gateway serves.
    env.ANTHROPIC_MODEL = model
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model
    env.ANTHROPIC_SMALL_FAST_MODEL = model
  } else if (config.authToken) {
    // Native Anthropic: an explicit bearer (e.g. a subscription/OAuth token)
    // still wins; otherwise the SDK uses the ambient ANTHROPIC_API_KEY or the
    // Claude Code login (subscription), left untouched.
    env.ANTHROPIC_AUTH_TOKEN = config.authToken
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
