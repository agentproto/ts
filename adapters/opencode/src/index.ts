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

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  CREDENTIAL_DATA_SUBDIR,
  createAgentCliRuntime,
  defineAgentCli,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/driver-agent-cli"
import { getModelsByProvider, listModels } from "@agentproto/model-catalog"

/**
 * Build OpenCode's model menu from the shared provider catalog instead of a
 * hand-maintained allowlist. OpenCode routes by the model id's own
 * `<provider>/<id>` prefix, so every entry carries the billing provider the
 * runtime's eligibility projection needs.
 *
 * Only providers OpenCode genuinely supports today are included:
 *   - Anthropic and OpenAI (direct vendor prefixes)
 *   - OpenRouter (`openrouter/<vendor>/<id>` router prefix)
 *   - OpenCode's own two hosted endpoints — `opencode-go/<id>` (the flat Go
 *     subscription) and `opencode/<id>` (Zen, pay-as-you-go), both matching
 *     opencode's own config spelling
 *
 * Groq is still omitted: it is not a billing/auth `CatalogProvider` (no
 * pricing generator), so there is nothing in the shared catalog to enumerate.
 * The `models.env` map carries its key env var, so a free-form `model`
 * override and a manually-curated profile continue to work. (The two OpenCode
 * endpoints USED to be omitted for the same reason — they are now first-class
 * catalog providers with their own generated route tables, which is what makes
 * them enumerable here.)
 *
 * `router: true` marks a provider whose surface lives ONLY in its generated
 * route table and is deliberately not spread into `LLM_PRICING_CATALOG` (a
 * bare `claude-sonnet-5` must keep meaning direct Anthropic, not a Zen-priced
 * route). `listModels` returns nothing for those, so they are read through
 * `getModelsByProvider`, which folds the route table in.
 */
function buildOpencodeModelMenu(): Array<{ id: string; provider: string }> {
  const supported = [
    { provider: "anthropic", prefix: "anthropic", router: false },
    { provider: "openai", prefix: "openai", router: false },
    { provider: "openrouter", prefix: "openrouter", router: false },
    { provider: "opencode-go", prefix: "opencode-go", router: true },
    { provider: "opencode", prefix: "opencode", router: true },
  ] as const

  const seen = new Set<string>()
  const out: Array<{ id: string; provider: string }> = []

  for (const { provider, prefix, router } of supported) {
    const models = router
      ? getModelsByProvider(provider).filter(model => model.kind === "llm")
      : listModels({ kind: "llm", provider })
    for (const model of models) {
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

/** Inline config the `lean` mode layers over the user's global opencode config. */
export const LEAN_INLINE_CONFIG = { mcp: { agentproto: { enabled: false } } } as const

export const opencode: AgentCliHandle = defineAgentCli({
  name: "opencode",
  id: "opencode",
  description:
    "sst/opencode — open-source coding agent with first-party ACP mode. Spawned via `npx -y opencode-ai acp` and driven over stdio JSON-RPC. Multi-provider (Anthropic / OpenAI / OpenRouter / Groq / OpenCode hosted).",
  version: "0.1.0",
  bin: "npx",
  // `--print-logs --log-level ERROR` makes the ACP server echo its structured
  // logs to stderr. Without it a provider 429/usage-cap is swallowed into an
  // internal retry loop and `session/prompt` never resolves, leaving the
  // daemon with a silent 0-token busy session. The driver's stderr hook
  // (`parseStderrStreamError`) reads those lines back into a turn error.
  bin_args: ["-y", "opencode-ai", "acp", "--print-logs", "--log-level", "ERROR"],
  install: [
    { method: "npm", package: "opencode-ai", global: true },
    { method: "curl", url: "https://opencode.ai/install" },
  ],
  version_check: {
    // PRESENCE probe — local binary check, not a registry query. Covers BOTH
    // install methods: the npm -g package and the curl installer both put an
    // `opencode` executable on PATH, and it runs `--version` fully offline.
    cmd: "opencode --version",
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
  // opencode keeps a console login (`account` row) in <XDG_DATA_HOME>/opencode/
  // opencode.db and, at every start, merges that login's active-org provider
  // block over env keys and inline config — so an engaged profile would bill
  // the ACTIVE ORG, not its own credential. An engaged spawn therefore runs in
  // a login-less data dir (`<configDir>/auth-data`).
  credentialDataHome: { env: "XDG_DATA_HOME" },
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
    // / OpenCode Go / OpenCode Zen models instead of a hardcoded 3-item list.
    // Groq stays omitted — it is not a billing/auth CatalogProvider, so there
    // is nothing to enumerate; the free-form `model` option and `models.env`
    // still support it.
    allowed: buildOpencodeModelMenu(),
    env: {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      // Both OpenCode endpoints read the SAME var — opencode's own convention
      // (models.dev records `env: ["OPENCODE_API_KEY"]` for each), mirrored in
      // the catalog's `PROVIDER_KEY_ENV`. Two DIFFERENT secrets share the name,
      // so which balance a spawn bills is decided by the resolved auth profile's
      // endpoint (`opencode` vs `opencode-go`), not by this map.
      opencode: "OPENCODE_API_KEY",
      "opencode-go": "OPENCODE_API_KEY",
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
  // `modes[]` carries ONE entry, the `context` axis (`lean`). opencode's
  // operation profiles (default / plan / build) are POSTURE, which no longer
  // lives in the manifest (SPEC §3.4a): opencode's own ACP server advertises
  // them as native session modes and switches them on the wire via
  // `session/set_config_option` (configId:"mode") / `session/set_mode` —
  // precisely the harness ACP mode registry (`SessionModeState.availableModes`)
  // posture is sourced from. route comes from the model catalog. What enters
  // the model's context has no ACP home, so it is the one thing declared here.
  modes: [
    {
      id: "lean",
      kind: "context",
      description:
        "Keep opencode's first request near its own floor (~8k tokens): no auto-discovered " +
        "skills (`.claude/skills`, `.agents/skills`, `~/.claude/skills` — a repo with 100+ skills " +
        "lists them all, ~20k tokens), no AGENTS.md / CLAUDE.md / project opencode.json pulled in " +
        "from the cwd and its parents (agentproto's own AGENTS.md pointer in the first prompt " +
        "already names the contract), and the user's global `agentproto` MCP bridge " +
        "(`mcp.agentproto` in ~/.config/opencode/opencode.jsonc — 280+ tool schemas, ~100k tokens " +
        "on every start) switched off. A daemon mount (`daemonMount`) is unaffected and stays " +
        "the way to reach daemon tools (deferred by default for executors).",
      // OPENCODE_DISABLE_EXTERNAL_SKILLS and OPENCODE_DISABLE_PROJECT_CONFIG are
      // read by the pinned opencode (1.18.x) at startup; measured in
      // `OPENCODE.md` ("First-request size"). OPENCODE_CONFIG_CONTENT is the
      // highest-precedence config layer and is deep-merged over the user's
      // global config, so `enabled:false` turns the global bridge off without
      // touching the file. Other user-declared global MCP servers are left alone.
      env: {
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_CONFIG_CONTENT: JSON.stringify(LEAN_INLINE_CONFIG),
      },
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
        "`opencode acp`. An id the server can't resolve REFUSES the spawn " +
        "with the server's reason (derived-from-model guard in " +
        "`define-agent-cli.ts`): opencode routes AND bills by the id's own " +
        "provider prefix, so silently keeping the server's default model " +
        "would run a model (and a bill) the operator didn't ask for.",
    },
    {
      id: "effort",
      // string, NOT enum: opencode advertises an `effort` config option
      // (category `thought_level`) ONLY for models that have a reasoning
      // axis, and the accepted vocabulary is MODEL-DEPENDENT — probed live
      // against `opencode acp` 1.18.x, one reasoning model offered
      // `high | max | default` while opencode's own `run --variant` help
      // names `high, max, minimal`. A static enum would reject labels that
      // are valid for models this adapter also routes to, so the value is
      // passed through and the server decides. Applied via ACP
      // `session/set_config_option(configId:"effort")` after the session is
      // created — `define-agent-cli.ts` reads `config.options.effort` and
      // forwards it to the ACP arm's `connect({effort})`; there is no
      // `opencode acp` CLI flag for it (`--variant` is a `run`-subcommand
      // flag, and the adapter spawns `acp`). The apply is best-effort and
      // non-fatal (`packages/acp`): a label the resolved model doesn't offer,
      // or a model with no effort axis at all, is warned about and ignored
      // rather than killing the spawn. Omit to keep the model's own default.
      type: "string" as const,
      description:
        "Reasoning effort (opencode's per-model thought level / `variant`). " +
        "Applied via ACP session/set_config_option(configId:\"effort\") after " +
        "the session is created; no `opencode acp` CLI flag exists for it. " +
        "The accepted vocabulary is MODEL-DEPENDENT — opencode advertises an " +
        "`effort` config option only for models with a reasoning axis, with " +
        "values like `high`/`max`/`default` (its `--variant` help also names " +
        "`minimal`). A label the resolved model doesn't offer is ignored " +
        "best-effort (never fails the spawn), and a model with no effort axis " +
        "ignores it entirely. Omit to keep the model's own default.",
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
  metadata: {
    // Opts opencode into `agentproto install skill/<slug>` fan-out (no
    // --target given). Confirmed against the installed opencode CLI +
    // published docs (opencode.ai/docs/skills/): it auto-discovers
    // `~/.config/opencode/skills/<name>/SKILL.md` (global) in addition to
    // project-local `.opencode/skills/`, `.claude/skills/`, `.agents/skills/`
    // — same flat-dir, one-subdir-per-skill shape as hermes.
    skills: { format: "flat-dir", dir: "~/.config/opencode/skills" },
  },
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
  ctx?: { cwd?: string; configDir?: string },
): Promise<{
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
} | null> {
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
    // An engaged-credential spawn ran with an isolated data home (see
    // `credentialDataHome`); its sessions live there, not in the global db.
    const isolatedDb = ctx?.configDir
      ? join(ctx.configDir, CREDENTIAL_DATA_SUBDIR, "opencode", "opencode.db")
      : undefined
    const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
    const dbPath =
      isolatedDb && existsSync(isolatedDb) ? isolatedDb : join(dataHome, "opencode", "opencode.db")
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      // `SELECT *` so an older opencode.db without the cache/reasoning
      // columns still reads (the missing ones just stay absent).
      const row = db.prepare("SELECT * FROM session WHERE id = ?").get(sessionId) as
        | {
            cost?: number | null
            tokens_input?: number | null
            tokens_output?: number | null
            tokens_cache_read?: number | null
            tokens_cache_write?: number | null
            tokens_reasoning?: number | null
          }
        | undefined
      if (!row) return null
      return {
        ...(row.cost != null ? { costUsd: Number(row.cost) } : {}),
        ...(row.tokens_input != null ? { tokensIn: row.tokens_input } : {}),
        ...(row.tokens_output != null ? { tokensOut: row.tokens_output } : {}),
        ...(row.tokens_cache_read != null ? { cacheReadTokens: row.tokens_cache_read } : {}),
        ...(row.tokens_cache_write != null ? { cacheWriteTokens: row.tokens_cache_write } : {}),
        ...(row.tokens_reasoning != null ? { reasoningTokens: row.tokens_reasoning } : {}),
      }
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

export {
  OPENCODE_CONSOLE_SOURCE,
  OPENCODE_CONSOLE_ORG_KIND,
  OPENCODE_CONSOLE_TOKEN_ENV,
  createOpencodeSubaccountProvider,
  opencodeSubaccounts,
  opencodeDbPath,
  readOpencodeConsoleAccount,
  listOpencodeConsoleOrgs,
  resolveOpencodeConsoleOrg,
} from "./subaccounts.js"
export type { AgentCliHandle, AgentCliRuntime }
