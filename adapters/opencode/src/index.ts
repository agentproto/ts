/**
 * @agentproto/adapter-opencode — AIP-45 adapter for sst/opencode.
 *
 * OpenCode ships first-party ACP support (`opencode acp`) so no
 * third-party wrapper is needed. We spawn it via `npx -y opencode-ai
 * acp` and drive it over stdio JSON-RPC the same way the claude-code
 * adapter drives @agentclientprotocol/claude-agent-acp.
 *
 *   import { opencode, opencodeRuntime } from "@agentproto/adapter-opencode"
 *   const session = await opencodeRuntime().start({
 *     env: { ANTHROPIC_API_KEY: "sk-..." },
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

export const opencode: AgentCliHandle = defineAgentCli({
  name: "opencode",
  id: "opencode",
  description:
    "sst/opencode — open-source coding agent with first-party ACP mode. Spawned via `npx -y opencode-ai acp` and driven over stdio JSON-RPC. Multi-provider (Anthropic / OpenAI / OpenRouter / Groq / OpenCode hosted).",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "opencode-ai", "acp"],
  install: [
    { method: "npm", package: "opencode-ai", global: true },
    { method: "curl", url: "https://opencode.ai/install" },
  ],
  version_check: {
    cmd: "npm view opencode-ai version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=1.0.0",
    timeout_ms: 15_000,
  },
  auth: {
    ref: "./SECRETS.md",
    state: {
      env: [
        "OPENCODE_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "GROQ_API_KEY",
      ],
    },
  },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./opencode-acp.ACP.md",
  session: {
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
  },
  models: {
    default: "anthropic/claude-sonnet-4-6",
    // Anthropic is no longer advertised as a pickable escalation — only the
    // adapter's own default Claude model stays listed (repointing the default
    // is out of scope). Premium Anthropic (Opus/Haiku) and the redundant
    // gateway dupe are dropped from the menu so orchestrators don't select
    // them here; the free-form `model` option still accepts any id.
    // `provider` is read straight off each id's own prefix — opencode routes
    // by that prefix itself, no adapter mode needed (unlike claude-sdk /
    // claude-code, which need ANTHROPIC_BASE_URL pre-wired by a mode).
    allowed: [
      { id: "anthropic/claude-sonnet-4-6", provider: "anthropic" },
      { id: "openai/gpt-5", provider: "openai" },
      { id: "openai/gpt-5-mini", provider: "openai" },
    ],
    env: {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      opencode: "OPENCODE_API_KEY",
      groq: "GROQ_API_KEY",
    },
  },
  capabilities: {
    streaming: true,
    tool_calls: true,
    sub_agents: false,
    file_io: true,
    // OpenCode forwards ACP image content blocks to the underlying
    // provider (Anthropic Messages API for Claude models, OpenAI vision
    // for GPT-5). Hosts SHOULD send `{type: "image", data, mimeType}`
    // blocks alongside text in `session.send`.
    multimodal: true,
    // OpenCode persists session state internally and the ACP server
    // implements newSession/loadSession/resumeSession. Pair with the
    // `native-resume` continuation strategy for cold-start reattach.
    resumable: true,
    bidirectional: true,
  },
  // `opencode acp --help` (v1.17.13) has no `--mode` or `--model` flag —
  // it's a yargs CLI that throws on any unrecognized flag, so either one
  // used to crash the spawned subprocess before ACP even connected. Unlike
  // claude-code's wrapper (which needs the CLAUDE_CONFIG_DIR trick for
  // mode), opencode's own ACP server implements `session/set_config_option`
  // with `configId` ∈ {"model", "effort", "mode"} directly on the wire —
  // no CLI flags involved. Both are applied post-`session/new`, not argv.
  modes: [
    { id: "default", description: "Standard interactive mode." },
    {
      id: "plan",
      description:
        "Plan-only mode — reasoning + proposals, no edits or shell calls.",
      // No CLI flag exists for this — applied via ACP
      // session/set_config_option(configId:"mode") after newSession.
      apply: "config",
    },
    {
      id: "build",
      description:
        "Auto-execute mode — file edits and shell commands run without per-step prompts.",
      apply: "config",
    },
  ],
  options: [
    {
      id: "model",
      type: "string",
      description:
        "Provider/model override for this operator binding (e.g. `openrouter/anthropic/claude-sonnet-4-6`). Applied via ACP " +
        "session/set_config_option after the session is created (see " +
        "`models.apply`, default \"config\"); no CLI flag for this exists on " +
        "`opencode acp`. An id the server can't resolve is warned about and " +
        "ignored (the session keeps the server's default model).",
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
  tags: ["opencode", "sst", "acp", "agent-runtime", "coding"],
})

export function opencodeRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(opencode)
}

export type { AgentCliHandle, AgentCliRuntime }
