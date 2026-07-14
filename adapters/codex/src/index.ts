/**
 * @agentproto/adapter-codex — AIP-45 adapter for OpenAI Codex via the
 * Zed-published ACP wrapper @zed-industries/codex-acp.
 *
 * The wrapper bundles its own Codex runtime (Rust binary delivered via
 * npm optional deps) so a single `npx -y @zed-industries/codex-acp`
 * invocation is enough — no separate @openai/codex install needed.
 *
 *   import { codex, codexRuntime } from "@agentproto/adapter-codex"
 *   const session = await codexRuntime().start({
 *     env: { OPENAI_API_KEY: "sk-..." },
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

export const codex: AgentCliHandle = defineAgentCli({
  name: "codex",
  id: "codex",
  description:
    "OpenAI's Codex coding agent wrapped as an ACP server by Zed's @zed-industries/codex-acp. Spawned via `npx -y @zed-industries/codex-acp` and driven over stdio JSON-RPC. The wrapper bundles its own Codex runtime — no separate @openai/codex install required.",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "@zed-industries/codex-acp"],
  install: [
    {
      method: "npm",
      package: "@zed-industries/codex-acp",
      global: true,
    },
  ],
  version_check: {
    cmd: "npm view @zed-industries/codex-acp version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.14.0",
    timeout_ms: 15_000,
  },
  auth: {
    ref: "./SECRETS.md",
    state: { env: ["OPENAI_API_KEY", "CODEX_API_KEY"] },
  },
  // Billing-auth (opt-in — no authEnforce, so unconfigured spawns stay
  // ambient). Single-provider adapter: api-key mode SETS providerEnvVar
  // ("openai") = OPENAI_API_KEY, derived from the catalog. No authSubscription
  // ⇒ a `subscription` request fails loud with `unsupported_auth_mode`.
  provider: "openai",
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./codex-acp.ACP.md",
  session: {
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
  },
  models: {
    default: "gpt-5-codex",
    allowed: ["gpt-5-codex", "gpt-5", "gpt-5-mini", "gpt-5-pro"],
    env: { openai: "OPENAI_API_KEY", codex: "CODEX_API_KEY" },
  },
  capabilities: {
    streaming: true,
    tool_calls: true,
    sub_agents: false,
    file_io: true,
    // The Zed wrapper forwards ACP image content blocks to Codex which
    // runs them through the underlying GPT-5 vision pipeline.
    multimodal: true,
    // codex-acp implements full ACP session lifecycle (newSession /
    // loadSession / resumeSession). Pair with the `native-resume`
    // continuation strategy for cold-start reattach.
    resumable: true,
    bidirectional: true,
  },
  modes: [
    {
      id: "default",
      description:
        "Auto mode (default) — Codex executes file edits and shell commands with per-tool prompts.",
    },
    {
      id: "read-only",
      description:
        "Read-only mode — Codex inspects but does not edit or run commands.",
      bin_args_append: ["--mode", "read-only"],
    },
    {
      id: "full-access",
      description:
        "Full-access mode — auto-approve all file/shell operations. Use only in trusted sandboxes.",
      bin_args_append: ["--mode", "full-access"],
    },
  ],
  options: [
    {
      id: "model",
      type: "enum",
      enum: ["gpt-5-codex", "gpt-5", "gpt-5-mini", "gpt-5-pro"],
      description: "Override the default model for this operator binding.",
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
  tags: ["codex", "openai", "acp", "agent-runtime", "coding"],
})

export function codexRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(codex)
}

export type { AgentCliHandle, AgentCliRuntime }
