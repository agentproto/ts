/**
 * `provider_key_list` — a read-only MCP view of the legacy per-provider key
 * store (`~/.agentproto/providers.json`, `@agentproto/providers-store`).
 *
 * That file holds the LLM-provider API keys `agentproto auth provider set`
 * writes; today only the CLI (`agentproto auth provider list`) can see it.
 * This tool is the daemon-side equivalent for a remote caller (the VS Code
 * extension, a cloud operator) that has no shell on this host — with one
 * hard constraint: it NEVER returns a key, only a one-way identity
 * (`fingerprint` / `last4`, the same helper `auth_profile_list` uses).
 *
 * `injectProviderKeysIntoEnv` (called once at `serve` boot) copies each file
 * key into the daemon's own env UNLESS that env var is already set — explicit
 * env always wins. So a file entry whose env var ends up holding the SAME
 * value was simply boot-injected; that is not shadowing. Only a env var
 * holding a DIFFERENT value than the file means some explicit env (a one-off
 * `FOO_API_KEY=… serve`, a CI secret) won instead, and the file's key is not
 * the one actually in effect for this process — that is `shadowedByEnv`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { registerBuiltinTool } from "@agentproto/mcp-server"
import { catchErrors } from "@agentproto/tool"
import { credentialIdentity } from "@agentproto/auth"
import { loadProviders, providerEnvVar, providerEnvAliases, PROVIDER_ENV_VARS } from "./providers-store.js"

/** Where a row's key material comes from. `file+env` means both a file entry
 *  AND a set env var exist for the provider (see `shadowedByEnv` for whether
 *  they agree); `env` is a known provider with no file entry at all. */
export type ProviderKeySource = "file" | "env" | "file+env"

/** `provider_key_list`'s per-provider row. NEVER carries the key itself. */
export interface ProviderKeyRow {
  provider: string
  /** The canonical env var this provider's key is injected as. */
  envVar: string
  /** Always true — a row is only ever emitted when a key is present
   *  somewhere (the file or, for an env-only row, the env). */
  set: boolean
  /** One-way fingerprint of the key currently backing this row (file entry,
   *  or the env value for an env-only row). */
  fingerprint?: string
  /** Trailing 4 chars of that key ("which key is this"); omitted when the
   *  key is too short to reveal a tail safely (see `credentialIdentity`). */
  last4?: string
  baseUrl?: string
  source: ProviderKeySource
  /** True only when an env var IS set and its value DIFFERS from the file's
   *  key — never true from the ordinary boot-injected case (env === file). */
  shadowedByEnv: boolean
}

function envNamesFor(provider: string): string[] {
  return [providerEnvVar(provider), ...providerEnvAliases(provider)]
}

interface EnvMatch {
  name: string
  value: string
}

/** First env name (canonical, then aliases) that's actually set — carrying
 *  WHICH name matched, so callers can dedupe by it. Some provider pairs
 *  share one canonical env name (`openai`/`openai-realtime`, `google`/
 *  `gemini-live`, `opencode`/`opencode-go` — see `PROVIDER_KEY_ENV` in
 *  `@agentproto/model-catalog`), so "this env name is set" does not mean
 *  "this specific provider's key is what set it". */
function envMatchFor(names: readonly string[], env: NodeJS.ProcessEnv): EnvMatch | undefined {
  for (const name of names) {
    const value = env[name]
    if (value) return { name, value }
  }
  return undefined
}

function baseUrlEnvVar(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BASE_URL`
}

/**
 * Build the `provider_key_list` rows: one per provider with a non-empty key
 * in `providers.json`, plus an env-only row for any other KNOWN provider
 * (`PROVIDER_ENV_VARS`) whose canonical env var or a verified alias is set in
 * `env` but has no file entry. `env` defaults to `process.env`; tests inject
 * a fixture object so nothing here ever touches the real daemon env.
 */
export async function buildProviderKeyRows(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderKeyRow[]> {
  const file = await loadProviders()
  const rows: ProviderKeyRow[] = []
  const seen = new Set<string>()
  // Env names already attributed to a row — dedupes the provider pairs that
  // share one canonical env name, so the shared secret is reported once,
  // under whichever provider claims it first (file rows first, then env-only
  // rows in sorted provider order).
  const claimedEnvNames = new Set<string>()

  for (const provider of Object.keys(file.providers).sort()) {
    const entry = file.providers[provider]
    if (!entry?.apiKey) continue
    seen.add(provider)
    const match = envMatchFor(envNamesFor(provider), env)
    if (match) claimedEnvNames.add(match.name)
    const identity = credentialIdentity(entry.apiKey)
    rows.push({
      provider,
      envVar: providerEnvVar(provider),
      set: true,
      fingerprint: identity.fingerprint,
      ...(identity.last4 !== undefined ? { last4: identity.last4 } : {}),
      ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      source: match ? "file+env" : "file",
      shadowedByEnv: match !== undefined && match.value !== entry.apiKey,
    })
  }

  for (const provider of Object.keys(PROVIDER_ENV_VARS).sort()) {
    if (seen.has(provider)) continue
    const match = envMatchFor(envNamesFor(provider), env)
    if (!match || claimedEnvNames.has(match.name)) continue
    claimedEnvNames.add(match.name)
    const identity = credentialIdentity(match.value)
    const baseUrl = env[baseUrlEnvVar(provider)]
    rows.push({
      provider,
      envVar: providerEnvVar(provider),
      set: true,
      fingerprint: identity.fingerprint,
      ...(identity.last4 !== undefined ? { last4: identity.last4 } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      source: "env",
      shadowedByEnv: false,
    })
  }

  return rows
}

export interface RegisterProviderKeyToolsOptions {
  /** Overrides `process.env` for the env-side of the comparison — tests
   *  inject a fixture so the real ambient shell env never leaks in. */
  env?: NodeJS.ProcessEnv
}

export function registerProviderKeyTools(
  server: McpServer,
  options: RegisterProviderKeyToolsOptions = {},
): void {
  const env = options.env ?? process.env
  const providerKeyListSchema = z.object({
    provider: z.string().optional().describe("Keep only this provider (e.g. anthropic)."),
  })
  type ProviderKeyListInput = z.infer<typeof providerKeyListSchema>

  registerBuiltinTool<ProviderKeyListInput, { providers: ProviderKeyRow[] }>(server, {
    id: "provider_key_list",
    description:
      "Read-only view of the legacy per-provider API-key store " +
      "(`~/.agentproto/providers.json`, written by `agentproto auth provider " +
      "set`) as reflected in the daemon's own process env. NEVER returns a " +
      "key: each row carries only a one-way `fingerprint` + `last4` (the same " +
      "identity helper `auth_profile_list` uses). One row per provider with a " +
      "stored file key, plus an env-only row for any other known provider " +
      "(anthropic, openrouter, openai, …) whose env var is set on this " +
      "process but absent from the file. `source` says where the key comes " +
      "from (`file`, `env`, or `file+env`). `shadowedByEnv` is true ONLY when " +
      "the env var holds a DIFFERENT value than the file: `serve` boot " +
      "(`injectProviderKeysIntoEnv`) copies each file key into env whenever " +
      "that env var isn't already set, so env === file is the ordinary " +
      "boot-injected case, not shadowing; a differing value means some " +
      "explicit env (a one-off `FOO_API_KEY=… serve`, a CI secret) won " +
      "instead and the file's key is not the one actually in effect. " +
      "Optional `provider` filters to one provider.",
    inputSchema: providerKeyListSchema,
    handler: async input => {
      const rows = await buildProviderKeyRows(env)
      return { providers: input.provider ? rows.filter(r => r.provider === input.provider) : rows }
    },
    transformers: [catchErrors()],
  })
}
