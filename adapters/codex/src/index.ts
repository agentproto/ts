/**
 * @agentproto/adapter-codex — AIP-45 adapter for OpenAI Codex via the
 * maintained ACP wrapper @agentclientprotocol/codex-acp.
 *
 * The wrapper bundles its own Codex runtime (Rust binary delivered via
 * npm dependency) so a single `npx -y @agentclientprotocol/codex-acp`
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
    "OpenAI's Codex coding agent wrapped as an ACP server by @agentclientprotocol/codex-acp. Spawned via `npx -y @agentclientprotocol/codex-acp` and driven over stdio JSON-RPC. The wrapper bundles a compatible Codex runtime — no separate @openai/codex install required.",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "@agentclientprotocol/codex-acp"],
  install: [
    {
      method: "npm",
      package: "@agentclientprotocol/codex-acp",
      global: true,
    },
  ],
  version_check: {
    cmd: "npm view @agentclientprotocol/codex-acp version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=1.1.7",
    timeout_ms: 15_000,
  },
  auth: {
    ref: "./SECRETS.md",
    state: { env: ["OPENAI_API_KEY", "CODEX_API_KEY"] },
  },
  // Billing-auth (opt-in — no authEnforce, so unconfigured spawns stay
  // ambient). Single-provider adapter: api-key mode SETS providerEnvVar
  // ("openai") = OPENAI_API_KEY, derived from the catalog.
  provider: "openai",
  // "Use my existing Codex login" — a FILE-BASED (external) subscription. The
  // Codex CLI's ChatGPT/subscription login lives in `~/.codex/auth.json`
  // (`tokens.access_token`), which the bundled codex runtime reads ITSELF; it
  // has no env-bearer channel like claude-code's CLAUDE_CODE_OAUTH_TOKEN. So
  // `external: true`: subscription mode injects NOTHING (no setEnv) — the host
  // verifies the login is present (fail-loud, via the `codex` provision recipe)
  // and the driver only SCRUBS the api-key vars so a leftover OPENAI_API_KEY /
  // CODEX_API_KEY can't silently flip the spawn to per-token API billing under
  // a "subscription" label. OPENAI_API_KEY is scrubbed automatically (it's the
  // provider's api-key var); CODEX_API_KEY is the sibling the codex runtime
  // also honors, so it's listed as a conflictEnv. Money-safe by construction:
  // no OAuth bearer is ever written into an api-key env var, because no bearer
  // is injected at all. An unconfigured codex spawn stays ambient — codex uses
  // its own auth.json precedence (a ChatGPT login already outranks an ambient
  // OPENAI_API_KEY), so this only ADDS an explicit, verified, billing-guaranteed
  // opt-in on top of that.
  authSubscription: {
    external: true,
    conflictEnv: ["CODEX_API_KEY"],
  },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./codex-acp.ACP.md",
  session: {
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
  },
  models: {
    // Do not declare a fixed default: a ChatGPT subscription exposes valid
    // models dynamically, and forcing a historic ID can make a session fail.
    // Keep this curated menu for catalog consumers and compatibility with the
    // existing CLI discovery contract. It is not a default or an allow-list:
    // explicit model IDs are still validated dynamically by Codex.
    allowed: [
      // Codex-specialized (coding) models.
      "gpt-5-codex",
      "gpt-5.1-codex",
      "gpt-5.1-codex-mini",
      "gpt-5.1-codex-max",
      "gpt-5.2-codex",
      // GPT-5 generalist family.
      "gpt-5",
      "gpt-5-mini",
      "gpt-5-nano",
      "gpt-5-pro",
      "gpt-5.1",
      "gpt-5.2",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.4-pro",
      "gpt-5.5",
      "gpt-5.5-pro",
      // GPT-5.6 family.
      "gpt-5.6-luna",
      "gpt-5.6-luna-pro",
      "gpt-5.6-sol",
      "gpt-5.6-sol-pro",
      "gpt-5.6-terra",
      "gpt-5.6-terra-pro",
      // GPT-4.1 / 4o generation.
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gpt-4o",
      "gpt-4o-mini",
      // o-series reasoning models.
      "o3",
      "o3-pro",
      "o3-mini",
      "o3-deep-research",
      "o4-mini",
      "o4-mini-high",
      "o4-mini-deep-research",
      "o1",
      "o1-mini",
      "o1-pro",
    ],
    env: { openai: "OPENAI_API_KEY", codex: "CODEX_API_KEY" },
    // The maintained ACP bridge exposes `session/set_config_option`, so the
    // model is selected after session creation rather than through argv.
    apply: "config",
  },
  capabilities: {
    streaming: true,
    tool_calls: true,
    sub_agents: false,
    file_io: true,
    // The maintained wrapper forwards ACP image content blocks to Codex which
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
      type: "string",
      description:
        "Optional Codex model ID. Omit it to use the model selected by the current ChatGPT or API-key account; the ACP bridge validates explicit IDs against that account.",
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
