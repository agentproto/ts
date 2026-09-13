/**
 * @agentproto/adapter-grok-cli — AIP-45 adapter for xAI's Grok Build CLI in
 * ACP mode (`grok agent stdio`).
 *
 * The Grok CLI (binary name `grok`, product name "Grok Build") is xAI's
 * official terminal coding agent — https://github.com/xai-org/grok-build,
 * docs at https://docs.x.ai/build/overview. `grok agent stdio` speaks real
 * Agent Client Protocol JSON-RPC 2.0 over stdio (verified live: `initialize`
 * returns `agentCapabilities`/`authMethods`/`sessionCapabilities`,
 * `session/new` returns a session id, `session/prompt` streams a reply).
 * There is no official npm package — xAI distributes it exclusively via the
 * installer script at https://x.ai/cli/install.sh (verified: downloads a
 * platform binary from x.ai/cli with a Google Cloud Storage fallback, no
 * npm involved). Do not confuse this with `@xai-official/grok` on npm,
 * which is NOT xAI's package (no linked repository, no homepage, an
 * "-official" scope name real orgs don't use for themselves, and a
 * publishing cadence inconsistent with a single vendor's release process).
 *
 *   import { grokCli, grokCliRuntime } from "@agentproto/adapter-grok-cli"
 *   const session = await grokCliRuntime().start({
 *     env: { XAI_API_KEY: "xai-..." },
 *   })
 *   for await (const evt of session.send({ role: "user", content: "..." })) {
 *     console.log(evt)
 *   }
 *   await session.close()
 */

import {
  createAgentCliRuntime,
  defineAgentCli,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/driver-agent-cli"

// Verified live against grok 1.0.3 (`grok models`, and the ACP `initialize`
// response's `modelState.availableModels`) — restricted to the text/coding
// models a chat session can select; the image/video generation models
// `grok models` also lists (grok-imagine-*) are invoked by the CLI's own
// image/video tools, not selectable as the session's chat model.
const GROK_TEXT_MODELS = [
  "grok-4.20-0309-non-reasoning",
  "grok-4.20-0309-reasoning",
  "grok-4.20-multi-agent-0309",
  "grok-4.3",
  "grok-4.5",
  "grok-4.6",
  "grok-build-0.1",
] as const

export const grokCli: AgentCliHandle = defineAgentCli({
  name: "grok-cli",
  id: "grok-cli",
  description:
    "xAI's official Grok Build CLI (`grok agent stdio`) — a Rust terminal coding agent driving Grok models over the Agent Client Protocol via stdio JSON-RPC. Installed via the official x.ai installer script (no npm package).",
  version: "0.1.0",
  bin: "grok",
  // `grok agent stdio` — the real ACP subcommand, verified by a live
  // initialize/session-new/session-prompt handshake against grok 1.0.3.
  bin_args: ["agent", "stdio"],
  install: [
    {
      // xAI ships no npm package for this CLI; the only official channel is
      // the installer script referenced from https://docs.x.ai/build/overview.
      method: "curl",
      url: "https://x.ai/cli/install.sh",
    },
  ],
  version_check: {
    cmd: "grok --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=1.0.0",
    timeout_ms: 15_000,
  },
  auth: {
    // Verified via `strings` on the grok binary ("Auth method: API key
    // (XAI_API_KEY)", "set XAI_API_KEY or model api_key/env_key in
    // config.toml") and the ACP `initialize` response's `authMethods`
    // (`xai.api_key`).
    state: { env: ["XAI_API_KEY"] },
  },
  // Billing-auth (opt-in — no authEnforce, so unconfigured spawns stay
  // ambient). Single-provider adapter: api-key mode SETS providerEnvVar
  // ("xai") = XAI_API_KEY, already registered in the model catalog
  // (packages/model-catalog/src/schema/base.ts PROVIDER_KEY_ENV.xai).
  provider: "xai",
  // "Use my existing Grok login" — a FILE-BASED (external) subscription. The
  // install script's own `read_grok_token` function reads
  // `~/.grok/auth.json` directly (populated by `grok login --oauth` /
  // `--device-auth`, ACP authMethod `grok.com` "Sign in with Grok"), which
  // the grok binary reads itself; there is no env-bearer channel like
  // claude-code's CLAUDE_CODE_OAUTH_TOKEN. So `external: true`: subscription
  // mode injects NOTHING (no setEnv) — the driver only scrubs XAI_API_KEY so
  // a leftover key can't silently flip the spawn to per-token API billing
  // under a "subscription" label. No sibling api-key var was found (unlike
  // gemini/codex) — `strings` on the binary surfaces only XAI_API_KEY as an
  // auth-relevant env var — so there is no separate conflictEnv beyond the
  // provider's own key, which the driver already scrubs automatically.
  authSubscription: {
    external: true,
  },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./grok-acp.ACP.md",
  session: {
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
  },
  models: {
    default: "grok-4.20-0309-non-reasoning",
    allowed: [...GROK_TEXT_MODELS],
    env: { xai: "XAI_API_KEY" },
    // The Grok CLI takes its model as the documented global `-m/--model`
    // flag (confirmed present on both `grok --help` and `grok agent --help`
    // on 1.0.3), composed into argv alongside `agent stdio`.
    apply: "arg",
    bin_args_template: ["-m", "{model}"],
  },
  capabilities: {
    streaming: true,
    tool_calls: true,
    // Verified false: the ACP `initialize` response's own
    // `agentCapabilities` does not advertise subagent delegation over ACP
    // (the CLI's internal `spawn_subagent` tool is a local tool call, not an
    // AIP-45 sub_agents capability).
    sub_agents: false,
    file_io: true,
    // Verified false: the ACP `initialize` response's
    // `promptCapabilities` is `{"image":false,"audio":false,"embeddedContext":true}`
    // — the agent does not accept image/audio content blocks over ACP.
    multimodal: false,
    // Verified true: `agentCapabilities.loadSession` is `true` and
    // `sessionCapabilities` includes `list`/`resume`/`close`.
    resumable: true,
    bidirectional: true,
  },
  options: [
    {
      id: "model",
      type: "enum",
      enum: [...GROK_TEXT_MODELS],
      description: "Override the default model for this operator binding.",
    },
  ],
  continuation: {
    default: "native-resume",
    supported: ["native-resume", "pinned-session", "transcript", "none"],
    pinned_session: {
      idle_timeout_ms: 1_800_000,
      key_scope: ["conversation", "operator"],
    },
  },
  tags: ["grok", "xai", "acp", "agent-runtime", "coding"],
})

export function grokCliRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(grokCli)
}

export type { AgentCliHandle, AgentCliRuntime }
