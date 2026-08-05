/**
 * @agentproto/adapter-claude-sdk — first-party adapter that runs Claude Code's
 * agent harness as a LIBRARY.
 *
 * Unlike `@agentproto/adapter-claude-code` (which wraps the third-party
 * `@agentclientprotocol/claude-agent-acp` bridge), this adapter drives the
 * Claude Agent SDK's headless `query()` directly behind an AIP-44 ACP server
 * (see ./acp-host.ts), shipped as a CLI bin (`agentproto-claude-sdk acp`). The
 * daemon spawns it like any other arm; a user can launch it standalone.
 *
 * Driving the SDK directly buys us clean model pinning (`options.model`, no
 * spawn-arg rejection — issue #186), native usage telemetry (a `usage_update`
 * per turn — #186 P3), and a custom `base_url` (`ANTHROPIC_BASE_URL`) that
 * points the same Anthropic-native harness at real Anthropic, Bedrock/Vertex/
 * Azure, or an Anthropic-compatible gateway.
 *
 *   import { claudeSdk, claudeSdkRuntime } from "@agentproto/adapter-claude-sdk"
 */

import { fileURLToPath } from "node:url"
import {
  createAgentCliRuntime,
  defineAgentCli,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/driver-agent-cli"
import { DEFAULT_MODEL } from "./options.js"

// Self-locating: the built handle spawns `node <this-dist>/cli.mjs acp`.
// import.meta.url resolves into dist/ at runtime, where cli.mjs sits next to
// index.mjs — so the same build works whether the daemon spawns it (resolved
// from node_modules) or a user runs the published bin.
const cliEntry = fileURLToPath(new URL("./cli.mjs", import.meta.url))

export const claudeSdk: AgentCliHandle = defineAgentCli({
  name: "claude-sdk",
  id: "claude-sdk",
  description:
    "First-party agentproto adapter — Claude Code's agent harness run as a " +
    "library via the Claude Agent SDK's headless query(), behind an AIP-44 ACP " +
    "server. 100% Anthropic-native I/O: clean model pinning (options.model), " +
    "native per-turn usage (tokens + cost), and a custom base_url " +
    "(ANTHROPIC_BASE_URL) to front real Anthropic, Bedrock/Vertex/Azure, or an " +
    "Anthropic-compatible gateway. Spawned as `node cli.mjs acp` over stdio " +
    "JSON-RPC, or launched standalone via `agentproto-claude-sdk acp`.",
  version: "0.1.0",
  bin: "node",
  bin_args: [cliEntry, "acp"],
  install: [
    {
      method: "npm",
      package: "@agentproto/adapter-claude-sdk",
      global: true,
    },
  ],
  // No external runtime to probe — the SDK's harness runs in the spawned node
  // process. A node version gate is enough to mark the arm ready.
  version_check: {
    cmd: "node --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=20.9.0",
    timeout_ms: 5000,
  },
  auth: {
    ref: "./claude-sdk.ACP.md",
    // Auth is read from the spawn env by the SDK. Either an Anthropic key/token
    // (direct or via an Anthropic-compatible gateway), or the cloud-provider
    // toggles below.
    state: {
      env: [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
      ],
    },
  },
  // Billing-auth (opt-in — authEnforce defaults to "when-configured", so an
  // unconfigured spawn stays ambient/unchanged). provider "anthropic" ⇒
  // api-key mode SETS ANTHROPIC_API_KEY. Unlike the claude-code CLI wrapper,
  // the SDK's subscription/bearer var is ANTHROPIC_AUTH_TOKEN (see
  // options.ts / cli.ts) — so that's this adapter's authSubscription.setEnv,
  // with the CLI's CLAUDE_CODE_OAUTH_TOKEN scrubbed as the sibling credential.
  provider: "anthropic",
  // A model's route is an independent choice here: gateway routing is
  // injected at runtime via `base_url`, so the same model can go
  // direct-Anthropic or via any gateway → free route selection.
  routeSelection: "free",
  authSubscription: {
    setEnv: "ANTHROPIC_AUTH_TOKEN",
    conflictEnv: ["CLAUDE_CODE_OAUTH_TOKEN"],
  },
  // How this adapter receives a GATEWAY-routed bearer credential (D4) —
  // ANTHROPIC_AUTH_TOKEN, the SAME var as the `auth_token` option below
  // (env: { ANTHROPIC_AUTH_TOKEN: "{value}" }) and the one the Claude Agent
  // SDK actually sends as `Authorization: Bearer`. Distinct from a gateway
  // preset's own `keyEnv` (OPENROUTER_API_KEY, MOONSHOT_API_KEY, …) — that's
  // merely where the operator's providers.json stores the key; the runtime's
  // resolveAuthSpec now injects the resolved credential HERE for a gateway
  // route instead, so it lands in a var the SDK actually reads.
  gatewayAuth: { setEnv: "ANTHROPIC_AUTH_TOKEN" },
  sandbox:
    "In-process: the SDK harness runs inside the spawned node process, scoped " +
    "to the daemon's cwd. Tool-permission handling defaults to " +
    "bypassPermissions (override via CLAUDE_SDK_PERMISSION_MODE); the daemon " +
    "owns the surrounding sandbox.",
  protocol: "acp",
  acp: "./claude-sdk.ACP.md",
  session: {
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
  },
  models: {
    // A cheap Claude by default — this is the budget first-party arm.
    default: DEFAULT_MODEL,
    // Curated model menu. `provider` states who serves/bills the model; the
    // runtime resolver supplies the matching ANTHROPIC_BASE_URL + credential
    // for gateway providers. This adapter no longer hard-codes gateway URLs
    // or modes — it declares routes/capabilities and consumes runtime-injected
    // ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN. The `model` option remains
    // free-form, so any gateway id works even if it is not listed here.
    allowed: [
      // Native Anthropic
      { id: "claude-haiku-4-5-20251001", provider: "anthropic" },
      { id: "claude-sonnet-5", provider: "anthropic" },
      { id: "claude-opus-4-8", provider: "anthropic" },
      { id: "claude-fable-5", provider: "anthropic" },
      // Gateway providers — routing is resolved by the runtime. OpenRouter ids
      // carry the `@openrouter` route-identity suffix so the catalog join pins
      // the gateway route (a bare 2-segment id resolves to the dead direct
      // vendor route instead).
      { id: "kimi-k3", provider: "moonshot" },
      { id: "kimi-k2.7-code", provider: "moonshot" },
      { id: "z-ai/glm-5.2@openrouter", provider: "openrouter" },
      { id: "deepseek/deepseek-v4-pro@openrouter", provider: "openrouter" },
      { id: "moonshotai/kimi-k2@openrouter", provider: "openrouter" },
      { id: "x-ai/grok-4.5@openrouter", provider: "openrouter" },
      { id: "x-ai/grok-4.20@openrouter", provider: "openrouter" },
      { id: "x-ai/grok-4.3@openrouter", provider: "openrouter" },
      { id: "google/gemini-3.1-pro-preview@openrouter", provider: "openrouter" },
      { id: "google/gemini-3.5-flash@openrouter", provider: "openrouter" },
      { id: "google/gemini-2.5-flash@openrouter", provider: "openrouter" },
      { id: "google/gemini-2.5-pro@openrouter", provider: "openrouter" },
      { id: "moonshotai/kimi-k2.7-code@openrouter", provider: "openrouter" },
      // OpenAI gpt-5.6 series via OpenRouter — reachable via ANTHROPIC_BASE_URL
      // + ANTHROPIC_AUTH_TOKEN (the gatewayAuth setEnv above) like the other
      // gateway rows. The `@openrouter` suffix pins the catalog join to the
      // OpenRouter gateway (the bare id would resolve to the direct-OpenAI
      // route, which the SDK's Anthropic surface can't speak). Real,
      // already-priced OpenRouter chat models, not invented specialist ids.
      { id: "openai/gpt-5.6-luna@openrouter", provider: "openrouter" },
      { id: "openai/gpt-5.6-sol@openrouter", provider: "openrouter" },
      // Requesty — route resolved from the catalog `@route`. Verified
      // runnable: a spawn on sference/thinkingcap-qwen3.6-27b@requesty is
      // accepted and produces the same route/profile/key-fingerprint
      // descriptor as the claude-code spawn on the same model.
      { id: "sference/thinkingcap-qwen3.6-27b@requesty", provider: "requesty" },
      { id: "sference/glm-5.2@requesty", provider: "requesty" },
      // Local llm-endpoint proxy — the `@llm-endpoint` suffix pins the catalog
      // join to the runtime-registered custom route (Anthropic surface at
      // localhost:18090). A SMALL curated set from the proxy's own `default`
      // pack (packages/llm-endpoint/src/packs.ts); the vendor prefix is the
      // proxy's transparent-provider name so the boundary-stripped
      // `vendor/product` upstream id transparently routes.
      { id: "moonshot/kimi-k3@llm-endpoint", provider: "llm-endpoint" },
      { id: "moonshot/kimi-k2.7-code@llm-endpoint", provider: "llm-endpoint" },
      { id: "moonshot/kimi-k2.6@llm-endpoint", provider: "llm-endpoint" },
      { id: "zai/glm-5.2@llm-endpoint", provider: "llm-endpoint" },
      { id: "openai/gpt-4.1@llm-endpoint", provider: "llm-endpoint" },
      { id: "openai/gpt-4o-mini@llm-endpoint", provider: "llm-endpoint" },
    ],
    env: {
      anthropic: "ANTHROPIC_API_KEY",
    },
  },
  capabilities: {
    streaming: true,
    // Claude Code's built-in tools (Read/Edit/Bash/…) and any injected MCP
    // tools run inside the harness and are relayed to the host as ACP
    // tool_call / tool_call_update updates (see acp-host.ts + message-map.ts).
    tool_calls: true,
    sub_agents: true,
    file_io: true,
    multimodal: false,
    // Turns resume via the SDK session store (options.resume), keyed by the
    // pinned session id.
    resumable: true,
    bidirectional: true,
  },
  // Operation modes. Only the native "default" profile remains as a manifest
  // mode — gateway routing is now resolved by the runtime and injected via
  // ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN. The adapter declares the
  // providers/models it can consume, but it no longer hard-codes gateway URLs.
  modes: [
    {
      id: "default",
      description:
        "Native Anthropic — the real Anthropic API (or whatever " +
        "ANTHROPIC_BASE_URL / cloud toggles the environment or runtime " +
        "resolver already sets). Uses the native Claude models in `allowed`.",
    },
  ],
  options: [
    {
      id: "model",
      // string (not enum) so any model id works without a code change — native
      // Claude ids, or a gateway id when a gateway mode is selected. Applied as
      // a `--model <id>` spawn arg → SDK options.model.
      type: "string" as const,
      description:
        "Model id → SDK options.model, applied as a `--model` arg at spawn. " +
        "Native Claude (e.g. 'claude-opus-4-8', 'claude-sonnet-5') in the " +
        "default mode, or any gateway id when base_url is set (e.g. " +
        "'kimi-k2.7-code', 'z-ai/glm-5.2@openrouter'). Omit for the adapter's default.",
      bin_args_template: ["--model", "{value}"],
    },
    {
      id: "base_url",
      // Injected into the child env as ANTHROPIC_BASE_URL — keeps the harness
      // Anthropic-native while fronting real Anthropic, a cloud provider, or an
      // Anthropic-compatible gateway (LiteLLM / claude-code-router). When set,
      // buildQueryOptions also pins every model tier to `model` (gateway mode).
      type: "string" as const,
      description:
        "Custom Anthropic base URL. Injected as ANTHROPIC_BASE_URL in the " +
        "child env — front real Anthropic, Bedrock/Vertex/Azure, or an " +
        "Anthropic-compatible gateway. When set, every internal model tier " +
        "(opus/sonnet/haiku/small-fast) is pinned to `model` so a single-model " +
        "gateway never gets an unservable tier. Omit to use the default endpoint.",
      env: { ANTHROPIC_BASE_URL: "{value}" },
    },
    {
      id: "auth_token",
      // Injected into the child env as ANTHROPIC_AUTH_TOKEN — the SDK sends it
      // as `Authorization: Bearer <token>`, which Anthropic-compatible gateways
      // (Moonshot, OpenRouter) accept. Pair with base_url for a per-spawn key.
      type: "string" as const,
      description:
        "Bearer token for the Anthropic API or a compatible gateway. Injected " +
        "as ANTHROPIC_AUTH_TOKEN in the child env (sent as `Authorization: " +
        "Bearer`). Pair with base_url to target a gateway (e.g. Moonshot, " +
        "OpenRouter) with a per-spawn key instead of the ambient " +
        "ANTHROPIC_API_KEY. Omit to use ANTHROPIC_API_KEY from the environment.",
      env: { ANTHROPIC_AUTH_TOKEN: "{value}" },
    },
    {
      id: "thinking",
      // Bare flag → cli.ts parses `--thinking` → SDK options.thinking =
      // { type: "enabled" }. Needed by thinking-gated gateway models such as
      // kimi-k2.7-code, which reject a request that omits `thinking`.
      type: "boolean" as const,
      description:
        "Enable extended thinking (SDK options.thinking = { type: 'enabled' }). " +
        "Required by thinking-gated gateway models such as Moonshot's " +
        "kimi-k2.7-code, which reject a request without it. Off by default — " +
        "native Claude models choose their own thinking behaviour.",
      bin_args_append_when_true: ["--thinking"],
    },
  ],
  tags: ["anthropic", "claude", "claude-agent-sdk", "agentproto", "acp", "first-party"],
})

export function claudeSdkRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(claudeSdk)
}

export {
  ClaudeSdkAcpAgent,
  promptText,
  type QueryFn,
} from "./acp-host.js"
export {
  buildQueryOptions,
  mapAcpMcpServers,
  DEFAULT_MODEL,
  type ClaudeSdkConfig,
} from "./options.js"
export {
  sdkMessageToUpdates,
  assistantMessageUpdates,
  userMessageUpdates,
  resultUsageUpdate,
  systemInitSessionId,
  toolKindForClaudeTool,
  toolCallTitle,
  type UsageSessionUpdate,
} from "./message-map.js"
export { runAcpOverStdio } from "./run.js"
export type { AgentCliHandle, AgentCliRuntime }
