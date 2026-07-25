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

import { join } from "node:path"
import {
  createAgentCliRuntime,
  defineAgentCli,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/driver-agent-cli"
import type {
  AuthStore,
  CapabilityStrategy,
  CredSource,
  ProviderCapability,
} from "@agentproto/provider-kit"

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
    // No ANTHROPIC_API_KEY — hermes is the budget arm and deliberately does
    // not route to Anthropic (see models.deny). Anthropic stays exclusive to
    // the claude-code adapter.
    state: { env: ["OPENROUTER_API_KEY", "OPENAI_API_KEY"] },
  },
  // Billing-auth (opt-in — no authEnforce, so unconfigured spawns stay
  // ambient). Single-provider adapter: api-key mode SETS providerEnvVar
  // ("openrouter") = OPENROUTER_API_KEY, derived from the catalog. No
  // authSubscription ⇒ `subscription` fails loud with `unsupported_auth_mode`.
  provider: "openrouter",
  // The endpoint falls out of the model id's vendor prefix — `openai/*` is
  // routed through OpenAI, everything else through OpenRouter (see the
  // `model` option) — so there is nothing independent to choose: picking the
  // model already fixes the route → derived-from-model.
  routeSelection: "derived-from-model",
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./hermes-acp.ACP.md",
  session: {
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
    // hermes's own ACP server has been observed to hit its internal
    // max-tool-iterations cap, produce a final answer, and then never
    // send the `prompt` JSON-RPC response — hanging the daemon's turn
    // drain loop forever with no other adapter-side signal available.
    // 5 minutes of true silence (reset on any ACP traffic, so a long
    // legitimate tool-call chain doesn't false-positive) is generous
    // enough to not trip during normal use.
    turn_idle_timeout_ms: 300_000,
  },
  models: {
    // Cheap OpenRouter models by default — hermes is the budget delegation
    // arm (a Sonnet default would defeat the purpose). glm-5.2 + deepseek
    // are the go-to cheap coders. `allowed` is only the curated menu: the
    // `model` option is free-form, so any OpenRouter id (kimi, qwen, …) can
    // still be passed even when it isn't listed here.
    default: "z-ai/glm-5.2@openrouter",
    allowed: [
      "z-ai/glm-5.2@openrouter",
      "deepseek/deepseek-v4-pro@openrouter",
      "meta-llama/llama-3.3-70b-instruct@openrouter",
      "openai/gpt-4",
      "x-ai/grok-4.5@openrouter",
      "x-ai/grok-4.20@openrouter",
      "x-ai/grok-4.3@openrouter",
      "google/gemini-3.1-pro-preview@openrouter",
      "google/gemini-3.5-flash@openrouter",
      "google/gemini-2.5-flash@openrouter",
      "google/gemini-2.5-pro@openrouter",
      "moonshotai/kimi-k2.7-code@openrouter",
    ],
    // Anthropic models are reserved for the dedicated claude-code adapter —
    // hermes must NEVER route to them, even if a caller passes the id
    // explicitly. Enforced at compose time (RuntimeConfigError), so the
    // budget arm can't silently burn premium Anthropic spend.
    deny: ["anthropic/*", "claude-*"],
    env: {
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
  modes: [
    {
      id: "default",
      description:
        "Standard interactive mode — loads ~/.hermes/config.yaml and auto-injects " +
        "rules/memory/preloaded skills as usual.",
    },
    {
      id: "lean",
      description:
        "Skip ~/.hermes/config.yaml, cutting the skills/rules/memory scaffolding hermes " +
        "would otherwise preload into context. Composed as `hermes --ignore-user-config " +
        "acp` — the global flag MUST precede the `acp` subcommand baked into `bin_args`, " +
        "which is why this needs bin_args_prepend rather than bin_args_append.",
      bin_args_prepend: ["--ignore-user-config"],
      status: "noop",
      status_note:
        "Measured no-op: --ignore-user-config skips ~/.hermes/config.yaml, but hermes " +
        "skills live in a separate skills dir (not config), so prompt-size is " +
        "byte-identical. The real lean lever is narrowing the mounted toolset, not " +
        "this flag.",
    },
  ],
  options: [
    {
      id: "skills",
      type: "string" as const,
      description:
        "Preload one or more agentskills.io-compatible skills for the session " +
        "(comma-separate for multiple), via hermes' `--skills` global flag. Same " +
        "prepend-before-`acp` constraint as the `lean` mode.",
      bin_args_prepend: ["--skills", "{value}"],
    },
    {
      id: "model",
      // string (not enum) so any valid OpenRouter/OpenAI model ID is accepted
      // without a code change to expand the list. Applied via ACP
      // newSession(model:...) — hermes reads the model from the ACP session
      // config, not from its own CLI args. Anthropic ids are denied
      // (models.deny) — those are reserved for the claude-code adapter.
      type: "string" as const,
      description:
        "Model ID routed through OpenRouter/OpenAI " +
        "(e.g. 'deepseek/deepseek-v4-pro', 'z-ai/glm-5.2@openrouter', 'moonshotai/kimi-k2@openrouter'). " +
        "Anthropic models are not permitted on hermes — use the claude-code " +
        "adapter for those. " +
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
  metadata: {
    // Opts hermes into `agentproto install skill/<slug>` fan-out (no
    // --target given): skills get copied one subdir per skill into
    // hermes's own skills directory, alongside whatever it ships
    // natively. See packages/cli/src/commands/skill-install/types.ts
    // `AdapterSkillsTarget` for the shape + guard.
    skills: { format: "flat-dir", dir: "~/.hermes/skills" },
  },
})

export function hermesRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(hermes)
}

/** Shape of one `~/.hermes/auth.json` `credential_pool` entry this strategy
 *  reads. Only non-secret fields — never the credential value itself. The
 *  pool's own `key_env` (when present) is preserved verbatim: hermes' native
 *  kimi/moonshot slot is `KIMI_API_KEY`, NOT `MOONSHOT_API_KEY`, so this must
 *  never derive/normalize an env var name from the provider id. */
interface HermesCredentialPoolEntry {
  provider?: unknown
  key_env?: unknown
  fingerprint?: unknown
  base_url?: unknown
  baseUrl?: unknown
}

interface HermesAuthFile {
  credential_pool?: unknown
}

interface HermesModelsCacheFile {
  models?: unknown
}

/**
 * Best-effort capability discovery for hermes: parses hermes' OWN native
 * stores (`~/.hermes/auth.json`, `~/.hermes/provider_models_cache.json`)
 * rather than the manifest's generic `models.env` slots, so it reflects
 * what's ACTUALLY configured on this host, not just what the adapter
 * declares it's capable of. Never throws — `discoverCapabilities` also
 * catches, but every read here is independently defensive so a single
 * malformed file doesn't blank out the providers a good file already
 * yielded.
 */
export const hermesCapabilities: CapabilityStrategy = async (def, ctx) => {
  const authPath = join(ctx.homeDir, ".hermes", "auth.json")
  const modelsCachePath = join(ctx.homeDir, ".hermes", "provider_models_cache.json")

  const authStores: AuthStore[] = [
    { kind: "file", path: "~/.hermes/auth.json", format: "json", providerKeyed: true },
  ]

  const providers: ProviderCapability[] = []
  const authRaw = await ctx.readFile(authPath)
  if (authRaw !== null) {
    try {
      const parsed = JSON.parse(authRaw) as HermesAuthFile
      const pool = Array.isArray(parsed.credential_pool) ? parsed.credential_pool : []
      for (const entry of pool as HermesCredentialPoolEntry[]) {
        if (typeof entry !== "object" || entry === null) continue
        const id = typeof entry.provider === "string" ? entry.provider : undefined
        if (!id) continue
        const keyEnv = typeof entry.key_env === "string" ? entry.key_env : undefined
        const fingerprint = typeof entry.fingerprint === "string" ? entry.fingerprint : undefined
        const baseUrl =
          typeof entry.base_url === "string"
            ? entry.base_url
            : typeof entry.baseUrl === "string"
              ? entry.baseUrl
              : undefined
        // Never guess an env var from the provider id (that's exactly the
        // KIMI_API_KEY vs MOONSHOT_API_KEY trap) — only trust an explicit
        // key_env; otherwise the credential's origin is the pool file itself.
        const source: CredSource = keyEnv
          ? { kind: "env", var: keyEnv }
          : { kind: "file", path: "~/.hermes/auth.json", pointer: `credential_pool[provider=${id}]` }
        providers.push({
          id,
          billingEndpoint: id,
          cred: {
            present: true,
            source,
            ...(fingerprint ? { fingerprint } : {}),
          },
          ...(baseUrl ? { baseUrl } : {}),
        })
      }
    } catch (err) {
      ctx.warn(
        `hermes capability discovery: could not parse ~/.hermes/auth.json: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  let ids: string[] | undefined
  let stale = true
  const cacheRaw = await ctx.readFile(modelsCachePath)
  if (cacheRaw !== null) {
    try {
      const parsedCache = JSON.parse(cacheRaw) as HermesModelsCacheFile
      ids = Array.isArray(parsedCache.models)
        ? parsedCache.models.filter((m): m is string => typeof m === "string")
        : undefined
      stale = false
    } catch (err) {
      ctx.warn(
        `hermes capability discovery: could not parse ` +
          `~/.hermes/provider_models_cache.json: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const modelApply = def.models?.apply
  return {
    adapter: def.id,
    source: "discovered",
    discoverable: "live",
    authStores,
    providers,
    models: {
      mechanism: "file-cache",
      ref: "hermes model --refresh",
      ...(ids ? { ids } : {}),
      stale,
    },
    endpointCompat: {},
    application: {
      modelApply: modelApply === "command" || modelApply === "arg" ? modelApply : "config",
      postureApply: "none",
      coupled: false,
    },
  }
}

import { homedir } from "node:os"

/** Best-effort read of a hermes session's cost/token usage from its state.db.
 *
 *  hermes writes the per-turn cost to state.db slightly AFTER the ACP turn
 *  ends, so a single read right at turn-end usually finds the cost column
 *  still null. We poll a few times with a short backoff until the cost lands
 *  (or give up — best-effort, never throws). Bounded so a missing write can't
 *  hang the caller (the turn-end path awaits this). */
export async function readHermesUsage(
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
    const dbPath = join(homedir(), ".hermes", "state.db")
    const ATTEMPTS = 6
    const DELAY_MS = 130
    let last: { costUsd?: number; tokensIn?: number; tokensOut?: number } | null = null
    for (let i = 0; i < ATTEMPTS; i++) {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const row = db.prepare(
        "select estimated_cost_usd as cost, input_tokens as ti, output_tokens as to_ from sessions where id = ?",
      ).get(sessionId) as { cost?: number; ti?: number; to_?: number } | undefined
      db.close()
      if (row) {
        last = { costUsd: row.cost, tokensIn: row.ti, tokensOut: row.to_ }
        // Cost has landed (non-null) → done. Otherwise keep polling: the row
        // exists but hermes hasn't written the cost for this turn yet.
        if (row.cost !== null && row.cost !== undefined) return last
      }
      if (i < ATTEMPTS - 1) await new Promise(r => setTimeout(r, DELAY_MS))
    }
    return last
  } catch {
    return null
  }
}

export type { AgentCliHandle, AgentCliRuntime }
