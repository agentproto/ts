/**
 * @agentproto/adapter-hermes — AIP-45 adapter for Nous Research's Hermes Agent.
 *
 * Re-exports a `defineAgentCli` instance plus the runtime factory so
 * a host can boot Hermes with one import:
 *
 *   import { hermes, hermesRuntime } from "@agentproto/adapter-hermes"
 *   const session = await hermesRuntime().start({ env: { OPENROUTER_API_KEY } })
 *   for await (const evt of session.send({ role: "user", content: "..." })) {
 *     console.log(evt)
 *   }
 *   await session.close()
 *
 * The companion HERMES.md / SECRETS.md / hermes-acp.ACP.md files in
 * this package describe the manifest, secret slots, and ACP wire
 * profile.
 */

import {
  createAgentCliRuntime,
  defineAgentCli,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/driver-agent-cli"

export const hermes: AgentCliHandle = defineAgentCli({
  name: "hermes",
  id: "hermes",
  description:
    "Nous Research's Hermes Agent — autonomous CLI agent with skills, sandboxes, memory plugins, and a built-in ACP server. Spawned as `hermes acp` and driven over stdio JSON-RPC.",
  version: "0.1.0",
  bin: "hermes",
  bin_args: ["acp"],
  install: [
    {
      method: "curl",
      url: "https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh",
    },
  ],
  version_check: {
    cmd: "hermes --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.13.0 <1.0.0",
    timeout_ms: 5000,
  },
  auth: {
    ref: "./SECRETS.md",
    state: { env: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] },
  },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./hermes-acp.ACP.md",
  session: {
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
  },
  models: {
    // Cheap OpenRouter models by default — hermes is the budget delegation
    // arm (a Sonnet default would defeat the purpose). glm-5.2 + deepseek
    // are the go-to cheap coders; the bigger models stay available.
    default: "z-ai/glm-5.2",
    allowed: [
      "z-ai/glm-5.2",
      "deepseek/deepseek-v4-pro",
      "meta-llama/llama-3.3-70b",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-7",
      "openai/gpt-4",
    ],
    env: {
      anthropic: "ANTHROPIC_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      openai: "OPENAI_API_KEY",
    },
    // hermes keeps its own configured default when given a model via the
    // ACP session config — selection must go through a `/model <id>`
    // control turn instead. See AgentCliModels.apply.
    apply: "command",
  },
  capabilities: {
    streaming: true,
    tool_calls: true,
    sub_agents: true,
    file_io: true,
    multimodal: true,
    resumable: false,
    bidirectional: true,
  },
  options: [
    {
      id: "model",
      // string (not enum) so any valid OpenRouter/Anthropic/OpenAI model ID is
      // accepted without requiring a code change to expand the list. Applied via
      // ACP newSession(model:...) — hermes reads the model from the ACP session
      // config, not from its own CLI args.
      type: "string" as const,
      description:
        "Model ID routed through OpenRouter/Anthropic/OpenAI " +
        "(e.g. 'anthropic/claude-sonnet-4-6', 'deepseek/deepseek-v4-pro', 'z-ai/glm-5.2'). " +
        "Applied via a `/model <id>` control turn after the session is created " +
        "(hermes ignores the ACP session model config). " +
        "Omit to use the hermes default.",
    },
    {
      id: "effort",
      type: "enum" as const,
      enum: ["low", "medium", "high", "xhigh", "max"],
      description:
        "Reasoning effort level passed to hermes via ACP newSession. " +
        "Omit to use the hermes default.",
    },
  ],
  tags: ["hermes", "nous", "acp", "agent-runtime"],
})

export function hermesRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(hermes)
}

export type { AgentCliHandle, AgentCliRuntime }
