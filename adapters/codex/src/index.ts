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
    // codex-acp takes its model as a CLI config override, not an ACP
    // session config — `codex-acp --help` documents `-c model="o3"`.
    // There is no `session/set_config_option` capability to fire at all
    // (confirmed against v0.16.0's `initialize` response); the model must
    // be composed into argv at spawn time instead.
    apply: "arg",
    bin_args_template: ["-c", 'model="{model}"'],
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
  // No manifest `modes[]`: codex's operation profiles (default / read-only /
  // full-access) are POSTURE, which no longer lives in the manifest (SPEC
  // §3.4a) — it is sourced from the harness's own ACP mode registry
  // (`SessionModeState.availableModes`) plus the daemon's canonical-posture
  // layer. codex has no context (`kind:"context"`) mode to declare, and route
  // comes from the model catalog, so the array would be empty — omit it.
  options: [
    {
      id: "model",
      type: "enum",
      enum: ["gpt-5-codex", "gpt-5", "gpt-5-mini", "gpt-5-pro"],
      description: "Override the default model for this operator binding.",
      // No bin_args_template here — codex-acp doesn't accept a bare
      // `--model` flag (`error: unexpected argument '--model' found`,
      // confirmed against v0.16.0; it crashes the process before the ACP
      // handshake even starts). This option exists only so
      // `config.options.model` validates; the real composition happens
      // via `models.apply: "arg"` above.
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
