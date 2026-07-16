/**
 * @agentproto/adapter-mastra-agent — the first-party agentproto agent.
 *
 * Unlike the codex/hermes/claude-code adapters (which wrap an external agent
 * CLI), this adapter IS the agent: an AIP-42 AGENT.md is run as a live Mastra
 * agent behind an AIP-44 ACP server (see ./acp-host.ts), shipped as a CLI bin
 * (`agentproto-mastra acp`). The daemon spawns it like any other arm; a user
 * can launch it standalone. Our loop, our models — no external CLI.
 *
 *   import { mastraAgent, mastraAgentRuntime } from "@agentproto/adapter-mastra-agent"
 */

import { fileURLToPath } from "node:url"
import {
  createAgentCliRuntime,
  defineAgentCli,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/driver-agent-cli"

// Self-locating: the built handle spawns `node <this-dist>/cli.mjs acp`.
// import.meta.url resolves into dist/ at runtime, where cli.mjs sits next to
// index.mjs — so the same build works whether the daemon spawns it (resolved
// from node_modules) or a user runs the published bin.
const cliEntry = fileURLToPath(new URL("./cli.mjs", import.meta.url))

export const mastraAgent: AgentCliHandle = defineAgentCli({
  name: "mastra-agent",
  id: "mastra-agent",
  description:
    "First-party agentproto agent — an AIP-42 AGENT.md run as a live Mastra agent behind an AIP-44 ACP server. No external agent CLI: our own loop, our own models (routed via Mastra's model gateway from the spawn env). Spawned as `node cli.mjs acp` over stdio JSON-RPC, or launched standalone via `agentproto-mastra acp`.",
  version: "0.1.0",
  bin: "node",
  bin_args: [cliEntry, "acp"],
  install: [
    {
      method: "npm",
      package: "@agentproto/adapter-mastra-agent",
      global: true,
    },
  ],
  // No external runtime to probe — the agent runs in the spawned node process.
  // A node version gate is enough to mark the arm ready.
  version_check: {
    cmd: "node --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=20.9.0",
    timeout_ms: 5000,
  },
  auth: {
    ref: "./mastra-agent.ACP.md",
    // The chosen model's provider key is read from the spawn env by Mastra's
    // model gateway. Any one of these covers the common providers.
    state: {
      env: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    },
  },
  sandbox:
    "In-process: the agent runs inside the spawned node process. Tool-level sandboxing is the responsibility of the tools the AGENT.md grants.",
  protocol: "acp",
  acp: "./mastra-agent.ACP.md",
  session: {
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
  },
  models: {
    // Cheap OpenRouter coder by default — this is the budget first-party arm.
    // Anthropic models are not advertised here (this arm shouldn't be steered
    // onto premium Anthropic spend); the free-form `model` option still
    // accepts any Mastra-routable id. `provider` is this id's OWN first
    // segment (see providerOf in model-resolver.ts) — Mastra's model router
    // reads it directly, no adapter mode needed. Note the double prefix on
    // the OpenRouter entries: "openrouter/" (provider) + the upstream id
    // OpenRouter itself expects (which happens to contain another "/").
    default: "openrouter/z-ai/glm-5.2",
    allowed: [
      { id: "openrouter/z-ai/glm-5.2", provider: "openrouter" },
      { id: "openrouter/deepseek/deepseek-v4-pro", provider: "openrouter" },
      { id: "openai/gpt-5", provider: "openai" },
    ],
    env: {
      anthropic: "ANTHROPIC_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      openai: "OPENAI_API_KEY",
    },
  },
  capabilities: {
    streaming: true,
    // Tool calls run inside Mastra and are relayed to the host as ACP
    // tool_call / tool_call_update session updates (see acp-host.ts +
    // tool-call-map.ts). The built-in default agent ships the workspace
    // toolset (read/edit/run), so this is on.
    tool_calls: true,
    sub_agents: false,
    file_io: false,
    multimodal: false,
    resumable: false,
    bidirectional: true,
  },
  options: [
    {
      id: "model",
      // string (not enum) so any Mastra-routable `provider/model` id works
      // without a code change. Applied as a `--model <id>` spawn arg.
      type: "string" as const,
      description:
        "Model id routed via Mastra's model gateway (e.g. " +
        "'openrouter/z-ai/glm-5.2', 'openrouter/deepseek/deepseek-v4-pro'). " +
        "Applied as a `--model` arg at spawn. Omit for the default.",
      bin_args_template: ["--model", "{value}"],
    },
  ],
  tags: ["mastra", "agentproto", "acp", "agent-runtime", "first-party"],
})

export function mastraAgentRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(mastraAgent)
}

export {
  makeAgentFactory,
  defaultAgentManifest,
  DEFAULT_MODEL,
  DEFAULT_TOOL_IDS,
} from "./default-agent.js"
export { MastraAcpAgent, promptText, type MastraLike } from "./acp-host.js"
export { resolveMastraModel, modelRefToString, providerOf } from "./model-resolver.js"
export { makeWorkspaceTools, resolveInCwd } from "./workspace-tools.js"
export { buildSqliteMemory, resolveMemoryDbPath } from "./memory.js"
export {
  chunkToSessionUpdate,
  toolKindFor,
  toolCallTitle,
  type MastraStreamChunk,
} from "./tool-call-map.js"
export { runAcpOverStdio } from "./run.js"
export type { AgentCliHandle, AgentCliRuntime }
