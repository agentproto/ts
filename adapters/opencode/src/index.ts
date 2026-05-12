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
    allowed: [
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-7",
      "anthropic/claude-haiku-4-5",
      "openai/gpt-5",
      "openai/gpt-5-mini",
      "openrouter/anthropic/claude-sonnet-4-6",
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
  modes: [
    { id: "default", description: "Standard interactive mode." },
    {
      id: "plan",
      description:
        "Plan-only mode — reasoning + proposals, no edits or shell calls.",
      bin_args_append: ["--mode", "plan"],
    },
    {
      id: "build",
      description:
        "Auto-execute mode — file edits and shell commands run without per-step prompts.",
      bin_args_append: ["--mode", "build"],
    },
  ],
  options: [
    {
      id: "model",
      type: "string",
      description:
        "Provider/model override for this operator binding (e.g. `openrouter/anthropic/claude-sonnet-4-6`).",
      bin_args_template: ["--model", "{value}"],
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
