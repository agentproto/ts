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
 * Boolean provider-select toggles the SDK's own `claude` binary groups
 * together with `CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX` (same
 * array, `ac4f1e4` build of `@anthropic-ai/claude-agent-sdk`) to pick a
 * cloud-provider endpoint ahead of `ANTHROPIC_BASE_URL`. Leaking any of these
 * from a Claude-Code parent shell wedges a gateway turn against the wrong
 * provider. Deliberately excludes the non-boolean config members of that same
 * array (`ANTHROPIC_VERTEX_PROJECT_ID`, `ANTHROPIC_AWS_WORKSPACE_ID`,
 * `ANTHROPIC_FOUNDRY_RESOURCE`, `CLOUD_ML_REGION`) and the provider
 * credential/skip-auth vars — both are inert once the toggle that gates them
 * is gone.
 */
const CLOUD_PROVIDER_REDIRECT_TOGGLES = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
] as const

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

/**
 * Default watchdog while one or more tool calls are pending (ms). Tool
 * execution is legitimately silent between the SDK's `tool_use` and the
 * matching `tool_result`, so the generation watchdog would otherwise abort a
 * healthy turn. This budget is used only while at least one tool is in flight;
 * once the last tool_result arrives the adapter falls back to
 * {@link DEFAULT_IDLE_TIMEOUT_MS} for the model's next generation. `0`
 * disables the tool-pending watchdog.
 */
export const DEFAULT_TOOL_IDLE_TIMEOUT_MS = 600_000

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
   * Extended idle watchdog used while one or more tool calls are pending. Tool
   * execution is silent between the SDK's `tool_use` and the matching
   * `tool_result`, so the normal generation watchdog would abort a healthy
   * turn. This budget is used only while at least one tool is in flight; once
   * the last tool_result arrives the adapter falls back to
   * {@link DEFAULT_IDLE_TIMEOUT_MS}. `0` disables. Defaults to
   * {@link DEFAULT_TOOL_IDLE_TIMEOUT_MS}. Overridable via
   * `CLAUDE_SDK_TOOL_IDLE_TIMEOUT_MS`.
   */
  toolIdleTimeoutMs?: number
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
 * Thrown by {@link buildQueryOptions} when a spawn requests a `vendor/product`
 * catalog-style model with no `base_url` to route it through — see that
 * function's "unrouted-model guard" doc section for the full rationale.
 * Distinct class (not a bare `Error`) so a host can pattern-match it if it
 * ever wants to.
 */
export class UnroutedGatewayModelError extends Error {
  constructor(model: string) {
    super(
      `claude-sdk: model "${model}" is a vendor/product catalog ref, but no ` +
        `base_url is configured to route it — this adapter would otherwise ` +
        `send it straight to the real Anthropic API, which either 400s ("not ` +
        `a valid model ID") or silently falls back to a real Claude model, ` +
        `still billed. Set a base_url that fronts the provider that actually ` +
        `serves "${model}" (e.g. route.gateway: "openrouter" for an ` +
        `OpenRouter-hosted model), or request a native claude-* model instead.`,
    )
    this.name = "UnroutedGatewayModelError"
  }
}

/**
 * True for a `vendor/product` catalog-style model ref (e.g.
 * `deepseek/deepseek-v4-flash-0731`, `z-ai/glm-5.2`) — the canonical form this
 * whole codebase uses for a gateway-routed model (see
 * `@agentproto/model-catalog/route-identity`'s module doc). Such an id is
 * NEVER valid on the real Anthropic wire (Anthropic's own ids — `claude-…`,
 * and every entry this adapter's `models.allowed` declares under `provider:
 * "anthropic"` — never contain a `/`), so one reaching here with no
 * `base_url` to route it through is unambiguously a dropped/skipped routing
 * step upstream, not a legitimate native spawn. A BARE gateway-native id (no
 * `/`, e.g. Moonshot's `kimi-k2.7-code`) is deliberately NOT flagged here —
 * that shape is ambiguous with a yet-unlisted native id, so guarding it would
 * risk a false positive; the `/` form has no such ambiguity. */
function isVendorProductModelRef(model: string): boolean {
  return model.includes("/")
}

/** True when the ambient env has already redirected the SDK to a cloud
 *  provider (Bedrock/Vertex/Foundry/…) via one of {@link
 *  CLOUD_PROVIDER_REDIRECT_TOGGLES} — those providers use their OWN model-id
 *  conventions, some of which DO contain vendor-prefixed segments (e.g.
 *  Bedrock's `anthropic.claude-…-v1:0` uses `.`, but a Bedrock inference
 *  profile ARN-style id can contain `/`), so the unrouted-model guard must not
 *  fire once a cloud redirect is already active. */
function hasCloudProviderRedirect(
  env: Record<string, string | undefined>,
): boolean {
  return CLOUD_PROVIDER_REDIRECT_TOGGLES.some((key) => Boolean(env[key]))
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
 *   resolved from the explicit `auth_token` or `ANTHROPIC_AUTH_TOKEN` in the
 *   spawn env; if neither resolves, no credential is presented (fail clean,
 *   never leak). Every internal model tier is also pinned to the resolved
 *   model so a single-model gateway never receives a tier it can't serve
 *   (e.g. Moonshot rejecting `claude-haiku-*`). The
 *   {@link CLOUD_PROVIDER_REDIRECT_TOGGLES} leaked from a Claude-Code parent
 *   shell are also scrubbed so the gateway `base_url` isn't overridden.
 *
 * Unrouted-model guard: when `base_url` is UNSET (native mode, or an already-
 * active cloud-provider redirect) and the model is a `vendor/product`
 * catalog-style ref (e.g. `deepseek/deepseek-v4-flash-0731` — see {@link
 * isVendorProductModelRef}), the model reaches the real Anthropic API
 * verbatim — a routing bug upstream (a gateway model whose `base_url`
 * injection was dropped, skipped, or never wired), never a legitimate native
 * spawn (Anthropic's own ids never contain `/`). Sending it anyway is exactly
 * the failure this guard exists to prevent: real dogfooding turned up THREE
 * distinct symptoms of it (an empty turn still billed, a 400 "not a valid
 * model ID" once the mis-prefixed id reached Anthropic, and — worst —
 * Anthropic silently answering with a real Claude model at full Anthropic
 * rates while the caller believed it was talking to the requested gateway
 * model). {@link buildQueryOptions} now fails FAST with {@link
 * UnroutedGatewayModelError} before any request is made — zero-cost, and the
 * error message names the exact model/gateway mismatch — rather than risking
 * any of those three silent-failure shapes.
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
  if (
    !config.baseUrl &&
    isVendorProductModelRef(model) &&
    !hasCloudProviderRedirect(baseEnv)
  ) {
    throw new UnroutedGatewayModelError(model)
  }
  const env: Record<string, string | undefined> = { ...baseEnv }
  if (config.baseUrl) {
    // Gateway mode (non-Anthropic host). Auth hygiene: an ambient
    // ANTHROPIC_API_KEY must NEVER reach a third-party gateway (it 401s AND
    // leaks the real Anthropic key). Resolve the gateway bearer from the
    // explicit auth_token or ANTHROPIC_AUTH_TOKEN in the spawn env, then scrub
    // the Anthropic key so exactly the gateway's own credential is presented;
    // if neither resolves, present no credential (fail clean, never leak).
    env.ANTHROPIC_BASE_URL = config.baseUrl
    const bearer = config.authToken ?? baseEnv.ANTHROPIC_AUTH_TOKEN
    delete env.ANTHROPIC_API_KEY
    if (bearer) env.ANTHROPIC_AUTH_TOKEN = bearer
    else delete env.ANTHROPIC_AUTH_TOKEN
    // A Claude-Code parent shell may leak CLAUDE_CODE_USE_BEDROCK / _VERTEX
    // (etc.) into this child's env; the SDK honours those ahead of
    // ANTHROPIC_BASE_URL, silently sending the turn to the wrong provider
    // instead of the gateway (the confirmed cause of turns wedging forever).
    // Scrub so exactly the gateway base_url + bearer are presented.
    for (const key of CLOUD_PROVIDER_REDIRECT_TOGGLES) delete env[key]
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
    // Stream partial (`stream_event`) messages so a long thinking / generation
    // stretch is observable live instead of surfacing only at message
    // boundaries. Two things depend on it: (1) the daemon's output ring — the
    // mapped text/thinking deltas keep `lastOutputAt` advancing during a long
    // busy turn instead of freezing until the next tool boundary; and (2) the
    // turn watchdog (acp-host `#nextMessage`), which resets on every SDK
    // message — without partials, a >90s thinking block (kimi-k2.7-code with
    // `--thinking`) yields NO message and the idle watchdog wrongly aborts a
    // healthy turn. See message-map's `streamEventUpdates`.
    includePartialMessages: true,
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
