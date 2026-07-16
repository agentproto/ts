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
import { ANTHROPIC_GATEWAY_PRESETS } from "@agentproto/provider-presets"
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
  authSubscription: {
    setEnv: "ANTHROPIC_AUTH_TOKEN",
    conflictEnv: ["CLAUDE_CODE_OAUTH_TOKEN"],
  },
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
    // Each entry states who serves it (`provider`) and, for a gateway model,
    // which mode below routes there (`mode`) — the mode pre-wires
    // ANTHROPIC_BASE_URL, so picking the model without it would send a
    // gateway id straight to real Anthropic. Native models need no mode:
    // `mode: default` is already this adapter's baseline. The `model`
    // option stays free-form, so any gateway id works even if it isn't
    // listed here.
    allowed: [
      // Native Anthropic — no mode switch needed
      { id: "claude-haiku-4-5-20251001", provider: "anthropic" },
      { id: "claude-sonnet-5", provider: "anthropic" },
      { id: "claude-opus-4-8", provider: "anthropic" },
      { id: "claude-fable-5", provider: "anthropic" },
      // Moonshot (Kimi) — mode: moonshot
      { id: "kimi-k2.7-code", provider: "moonshot", mode: "moonshot" },
      // OpenRouter — mode: openrouter
      { id: "z-ai/glm-5.2", provider: "openrouter", mode: "openrouter" },
      { id: "deepseek/deepseek-v4-pro", provider: "openrouter", mode: "openrouter" },
      { id: "moonshotai/kimi-k2", provider: "openrouter", mode: "openrouter" },
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
  // Gateway presets. The base_url/auth_token/thinking options already let a
  // caller front any Anthropic-compatible gateway by hand; these modes just
  // pre-wire the endpoint (and, for Moonshot, the model + --thinking) so the
  // caller only has to supply the key. The `model` option still overrides.
  modes: [
    {
      id: "default",
      description:
        "Native Anthropic — the real Anthropic API (or whatever " +
        "ANTHROPIC_BASE_URL / cloud toggles the environment already sets). " +
        "Uses the native Claude models in `allowed`.",
    },
    {
      id: ANTHROPIC_GATEWAY_PRESETS.moonshot.id,
      description:
        "Moonshot (Kimi) gateway. Pre-wires ANTHROPIC_BASE_URL to Moonshot's " +
        "Anthropic-compatible endpoint, defaults the model to kimi-k2.7-code, " +
        "and enables --thinking (Kimi rejects a request without it). Supply the " +
        "Moonshot key via the `auth_token` option (or ANTHROPIC_AUTH_TOKEN); " +
        "override `model` for another Moonshot model.",
      env: {
        ANTHROPIC_BASE_URL: ANTHROPIC_GATEWAY_PRESETS.moonshot.baseUrl,
        // cli.ts reads CLAUDE_SDK_MODEL as the model fallback (a `--model`
        // option still wins), so the mode ships a working default model.
        CLAUDE_SDK_MODEL: ANTHROPIC_GATEWAY_PRESETS.moonshot.defaultModel,
        // Declares this gateway's conventional credential source.
        // buildQueryOptions resolves the bearer from this env when no explicit
        // auth_token / ANTHROPIC_AUTH_TOKEN is set, and always scrubs the
        // ambient ANTHROPIC_API_KEY so it never reaches a non-Anthropic host.
        CLAUDE_SDK_GATEWAY_KEY_ENV: ANTHROPIC_GATEWAY_PRESETS.moonshot.keyEnv,
      },
      bin_args_append: ["--thinking"],
    },
    {
      id: ANTHROPIC_GATEWAY_PRESETS.openrouter.id,
      description:
        "OpenRouter gateway. Pre-wires ANTHROPIC_BASE_URL to OpenRouter's " +
        "Anthropic-compatible endpoint. Pick a model via the `model` option " +
        "(e.g. 'z-ai/glm-5.2', 'deepseek/deepseek-v4-pro', 'moonshotai/kimi-k2') " +
        "and supply the OpenRouter key via `auth_token` (or ANTHROPIC_AUTH_TOKEN).",
      env: {
        ANTHROPIC_BASE_URL: ANTHROPIC_GATEWAY_PRESETS.openrouter.baseUrl,
        // Conventional credential source for this gateway (see moonshot above).
        CLAUDE_SDK_GATEWAY_KEY_ENV: ANTHROPIC_GATEWAY_PRESETS.openrouter.keyEnv,
      },
    },
    {
      id: ANTHROPIC_GATEWAY_PRESETS.deepseek.id,
      description:
        "DeepSeek gateway. Pre-wires ANTHROPIC_BASE_URL to DeepSeek's " +
        "Anthropic-compatible endpoint and defaults the model to " +
        "deepseek-v4-pro. Supply the DeepSeek key via the `auth_token` option " +
        "(or ANTHROPIC_AUTH_TOKEN); override `model` for deepseek-v4-flash. " +
        "Thinking is opt-in (DeepSeek accepts requests without it, unlike Kimi).",
      env: {
        ANTHROPIC_BASE_URL: ANTHROPIC_GATEWAY_PRESETS.deepseek.baseUrl,
        // cli.ts reads CLAUDE_SDK_MODEL as the model fallback (a `--model`
        // option still wins), so the mode ships a working default model.
        CLAUDE_SDK_MODEL: ANTHROPIC_GATEWAY_PRESETS.deepseek.defaultModel,
        // Conventional credential source for this gateway (see moonshot above).
        CLAUDE_SDK_GATEWAY_KEY_ENV: ANTHROPIC_GATEWAY_PRESETS.deepseek.keyEnv,
      },
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
        "default mode, or a gateway id when mode is moonshot/openrouter " +
        "(e.g. 'kimi-k2.7-code', 'z-ai/glm-5.2'). Omit for the mode's default.",
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
