/**
 * @agentproto/adapter-claude-code — AIP-45 adapter for Anthropic's
 * Claude Code via the @agentclientprotocol/claude-agent-acp wrapper.
 */

import {
  createAgentCliRuntime,
  defineAgentCli,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/driver-agent-cli"

export const claudeCode: AgentCliHandle = defineAgentCli({
  name: "claude-code",
  id: "claude-code",
  description:
    "Anthropic's Claude Code wrapped as an ACP agent via @agentclientprotocol/claude-agent-acp. Spawned via `npx -y @agentclientprotocol/claude-agent-acp` and driven over stdio JSON-RPC.",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "@agentclientprotocol/claude-agent-acp"],
  install: [
    {
      method: "npm",
      package: "@agentclientprotocol/claude-agent-acp",
      global: true,
    },
  ],
  version_check: {
    cmd: "npm view @agentclientprotocol/claude-agent-acp version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.30.0",
    timeout_ms: 15_000,
  },
  auth: {
    ref: "./SECRETS.md",
    state: { env: ["ANTHROPIC_API_KEY"] },
  },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./claude-code-acp.ACP.md",
  session: {
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
  },
  models: {
    default: "claude-sonnet-4-6",
    allowed: ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5"],
    env: { anthropic: "ANTHROPIC_API_KEY" },
  },
  capabilities: {
    streaming: true,
    tool_calls: true,
    sub_agents: false,
    file_io: true,
    multimodal: false,
    resumable: false,
    bidirectional: true,
  },
  tags: ["claude-code", "anthropic", "acp", "agent-runtime", "coding"],
})

export function claudeCodeRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(claudeCode)
}

export type { AgentCliHandle, AgentCliRuntime }
