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

import { homedir } from "node:os"
import { join } from "node:path"
import {
  createAgentCliRuntime,
  defineAgentCli,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/driver-agent-cli"
import { listModels } from "@agentproto/model-catalog"

/**
 * Build OpenCode's model menu from the shared provider catalog instead of a
 * hand-maintained allowlist. OpenCode routes by the model id's own
 * `<provider>/<id>` prefix, so every entry carries the billing provider the
 * runtime's eligibility projection needs.
 *
 * Only providers OpenCode genuinely supports today are included:
 *   - Anthropic and OpenAI (direct vendor prefixes)
 *   - OpenRouter (`openrouter/<vendor>/<id>` router prefix)
 *
 * Groq and OpenCode-hosted are omitted from the generated menu because they
 * are not represented in the shared catalog / profile system today. The
 * `models.env` map still carries their key env vars, so free-form `model`
 * overrides and manually-curated profiles continue to work.
 */
function buildOpencodeModelMenu(): Array<{ id: string; provider: string }> {
  const supported = [
    { provider: "anthropic", prefix: "anthropic" },
    { provider: "openai", prefix: "openai" },
    { provider: "openrouter", prefix: "openrouter" },
  ] as const

  const seen = new Set<string>()
  const out: Array<{ id: string; provider: string }> = []

  for (const { provider, prefix } of supported) {
    for (const model of listModels({ kind: "llm", provider })) {
      const bareId = model.id
      const canonicalId = bareId.includes("/") ? bareId : `${prefix}/${bareId}`
      const id = provider === "openrouter" ? `openrouter/${bareId}` : canonicalId
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, provider })
    }
  }

  return out.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider)
    return a.id.localeCompare(b.id)
  })
}

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
  // opencode routes by the model id's own `<provider>/<id>` prefix itself, no
  // adapter mode — unlike claude-sdk/claude-code, which need ANTHROPIC_BASE_URL
  // pre-wired by a mode. So the route falls out of the chosen model →
  // derived-from-model. The API key env var is also derived from the model's
  // provider prefix, so the runtime must know to present api-key auth on the
  // model-derived direct endpoint.
  routeSelection: "derived-from-model",
  modelDerivedApiKey: true,
  // opencode ships TWO native OAuth logins reached via `opencode auth login`
  // (provider selection), both stored in its own auth.json — the runtime
  // declares one provider-scoped `authSubscription` surface per login (see
  // `subscriptionSurfaceFor` in `@agentproto/runtime`'s spawn-defaults.ts,
  // which resolves the matching entry for a spawn's resolved provider).
  // Both are EXTERNAL: the runtime injects no bearer — an agentproto-held
  // `sk-ant-oat…`/ChatGPT access token presented on opencode's x-api-key
  // channel is rejected upstream as an invalid key, so the ONLY working
  // subscription path is the CLI's own login. Each entry verifies its own
  // login is present (fail-loud, via the `opencode` provision recipe's
  // `anthropic-oauth`/`openai-oauth` methods) and scrubs the matching
  // api-key var so a leftover ANTHROPIC_API_KEY/OPENAI_API_KEY can't
  // override it.
  //   - anthropic: "Claude Pro/Max" OAuth login (browser/headless).
  //   - openai: "ChatGPT Pro/Plus" OAuth login (browser/headless, against
  //     auth.openai.com). Reverse-engineered from the shipped binary (no
  //     OSS source available for this build): opencode keys BOTH the
  //     ChatGPT OAuth login and the plain API-key credential for this
  //     provider under the SAME auth.json key `openai` (there is no
  //     separate "chatgpt" key) — the generic `Cli.providers.login` /
  //     `Auth.set(provider.id, …)` write path is provider-id-keyed, not
  //     method-keyed. See the `opencode` provision recipe's `openai-oauth`
  //     method docblock for the full trace.
  // Each is scoped to its own `provider`, so neither ever lights up the
  // other's (or openrouter/groq's) models.
  authSubscription: [
    { external: true, provider: "anthropic" },
    { external: true, provider: "openai" },
  ],
  models: {
    // Default to a canonical catalog model (claude-sonnet-4-5). The legacy
    // alias `claude-sonnet-4-6` still resolves to the same model, but the
    // generated menu uses canonical ids from the shared catalog.
    default: "anthropic/claude-sonnet-4-5",
    // Generated from the shared provider catalog so the Configuration Lab /
    // harness picker shows genuinely runnable Anthropic / OpenAI / OpenRouter
    // models instead of a hardcoded 3-item list. Groq and OpenCode-hosted are
    // omitted because they are not represented in the catalog/profile system
    // today; the free-form `model` option and `models.env` still support them.
    allowed: buildOpencodeModelMenu(),
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
  // No manifest `modes[]`: opencode's operation profiles (default / plan /
  // build) are POSTURE, which no longer lives in the manifest (SPEC §3.4a).
  // opencode's own ACP server already advertises these as native session modes
  // and switches them on the wire via `session/set_config_option`
  // (configId:"mode") / `session/set_mode` — precisely the harness ACP mode
  // registry (`SessionModeState.availableModes`) posture is now sourced from,
  // so declaring them here would only duplicate the harness's own truth. route
  // comes from the model catalog and opencode has no context mode, so the array
  // would be empty — omit it.
  options: [
    {
      id: "model",
      type: "string",
      description:
        "Provider/model override for this operator binding (e.g. `openrouter/anthropic/claude-sonnet-4-6`). Applied via ACP " +
        "session/set_config_option after the session is created (see " +
        "`models.apply`, default \"config\"); no CLI flag for this exists on " +
        "`opencode acp`. An id the server can't resolve REFUSES the spawn " +
        "with the server's reason (derived-from-model guard in " +
        "`define-agent-cli.ts`): opencode routes AND bills by the id's own " +
        "provider prefix, so silently keeping the server's default model " +
        "would run a model (and a bill) the operator didn't ask for.",
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

/**
 * Best-effort per-session usage reader, mirroring `readHermesUsage` in
 * `@agentproto/adapter-hermes`. OpenCode's live ACP `usage_update` event only
 * ever carries `{used, size, cost}` — no token fields exist on that wire
 * event at all (confirmed by disassembling the installed opencode acp
 * binary) — so `session_usage` can't get tokensIn/tokensOut from the live
 * stream the way it does for other adapters. OpenCode does persist full
 * token detail to its own sqlite store though (the same store
 * `exportOpenCodeSession` in `@agentproto/runtime`'s transcript-export.ts
 * reads for `sessions export --json`), so this hook re-reads it directly.
 */
export async function readOpenCodeUsage(
  sessionId: string,
): Promise<{ costUsd?: number; tokensIn?: number; tokensOut?: number } | null> {
  try {
    // node:sqlite is a Node 22+ builtin. Build the specifier at runtime so the
    // bundler (esbuild/tsup) can't statically rewrite it — it strips the
    // `node:` prefix off this not-yet-recognised builtin, turning the import
    // into a missing `sqlite` package that throws and silently yields null.
    const sqliteSpecifier = ["node", "sqlite"].join(":")
    const { DatabaseSync } = (await import(sqliteSpecifier)) as unknown as {
      DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => {
        prepare(sql: string): { get(...a: unknown[]): unknown }
        close(): void
      }
    }
    const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
    const dbPath = join(dataHome, "opencode", "opencode.db")
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db
        .prepare("SELECT cost, tokens_input AS ti, tokens_output AS to_ FROM session WHERE id = ?")
        .get(sessionId) as { cost?: number; ti?: number; to_?: number } | undefined
      if (!row) return null
      return {
        ...(row.cost != null ? { costUsd: Number(row.cost) } : {}),
        ...(row.ti != null ? { tokensIn: row.ti } : {}),
        ...(row.to_ != null ? { tokensOut: row.to_ } : {}),
      }
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

export type { AgentCliHandle, AgentCliRuntime }
