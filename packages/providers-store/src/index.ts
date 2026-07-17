/**
 * `~/.agentproto/providers.json` — the provider API-key store (mode 0600).
 *
 * Distinct from `credentials.json` (host-binding OAuth tokens for
 * `serve --connect`) and from per-adapter `setup[]` tokens. This file holds
 * the LLM/model **provider** keys (anthropic, openrouter, openai, …) that the
 * model gateways in spawned agents read from the environment.
 *
 * Why a store at all: before this, the only way to give the daemon a provider
 * key was an ambient `export FOO_API_KEY=…` in whatever shell launched
 * `serve`. That's invisible, easy to forget, and per-shell. Storing the keys
 * here (0600, same-user-only) lets `serve` inject them at boot — set once,
 * works for every daemon. Explicit env still wins (see injectProviderKeysIntoEnv).
 *
 * Keys never leave this file except into the daemon's own process env; they
 * are never logged. A browser-loaded localhost page can't read a 0600 file —
 * the same defence the runtime.json bearer token relies on.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { PROVIDER_KEY_ENV, PROVIDER_KEY_ENV_ALIASES } from "@agentproto/model-catalog"

/**
 * Canonical provider → environment-variable name. The spawned model gateways
 * (Mastra in mastra-agent, hermes/opencode's routers) read the provider key
 * from these env names. Aligned with the adapter manifests' `models.env`
 * maps + the common SDK conventions.
 *
 * DERIVED from `@agentproto/model-catalog`'s {@link PROVIDER_KEY_ENV} (the
 * single source of truth, co-located with the provider enum — DECISION 1) so
 * the two maps that used to restate the same fact can't drift, plus the few
 * NON-catalog gateway providers this store also fronts (`groq`,
 * `vercel-ai-gateway`) which aren't LLM-catalog `provider` values but still
 * carry a key here. Adding a catalog provider forces adding its key env in the
 * catalog (the `Record<CatalogProvider, string>` is exhaustive), and it flows
 * through to here for free.
 */
export const PROVIDER_ENV_VARS: Readonly<Record<string, string>> = {
  ...PROVIDER_KEY_ENV,
  // ── Non-catalog gateway providers (not LLM-catalog `provider` enum values,
  //    so absent from PROVIDER_KEY_ENV, but still keyed through this store) ──
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  // Vercel AI Gateway — a gateway provider, like openrouter, that fronts many
  // upstream model families behind one key.
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
}

/**
 * Provider → ADDITIONAL env-var names its stored key also satisfies, beyond the
 * canonical {@link PROVIDER_ENV_VARS} name. DERIVED from the catalog's
 * {@link PROVIDER_KEY_ENV_ALIASES} (the single source of truth, same as
 * `PROVIDER_ENV_VARS` derives from `PROVIDER_KEY_ENV`) so the alias facts live
 * in one place. `injectProviderKeysIntoEnv` sets the canonical name AND every
 * alias here, letting one `auth provider set` satisfy a consumer that reads a
 * different env name (e.g. mastracode reads `GOOGLE_API_KEY`, not our canonical
 * `GOOGLE_GENERATIVE_AI_API_KEY`). No non-catalog gateway provider has a known
 * alias today; add them alongside the spread if one ever does.
 */
export const PROVIDER_ENV_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ...PROVIDER_KEY_ENV_ALIASES,
}

export type KnownProvider = keyof typeof PROVIDER_ENV_VARS

export interface ProviderEntry {
  /** The provider API key (or gateway key). */
  apiKey: string
  /** Optional custom base URL (self-hosted / proxy). */
  baseUrl?: string
  /** Wall-clock ISO timestamp the key was last set. */
  updatedAt: string
}

export interface ProvidersFile {
  version: 1
  providers: Record<string, ProviderEntry>
}

/** Fresh empty file each call — never share the `providers` object, or a
 *  later `setProviderKey` mutation leaks into every other load in-process. */
function emptyFile(): ProvidersFile {
  return { version: 1, providers: {} }
}

export function providersPath(): string {
  return resolve(homedir(), ".agentproto", "providers.json")
}

/** Resolve the env-var name for a provider (canonical map, else
 *  `<PROVIDER>_API_KEY` upper-snake fallback so new providers still work). */
export function providerEnvVar(provider: string): string {
  return (
    PROVIDER_ENV_VARS[provider] ??
    `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`
  )
}

/** Additional env-var names a provider's stored key also satisfies, beyond
 *  {@link providerEnvVar}. Empty for providers with no verified alias. */
export function providerEnvAliases(provider: string): readonly string[] {
  return PROVIDER_ENV_ALIASES[provider] ?? []
}

export async function loadProviders(): Promise<ProvidersFile> {
  try {
    const raw = await readFile(providersPath(), "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("providers" in parsed) ||
      typeof (parsed as Record<string, unknown>).providers !== "object" ||
      (parsed as Record<string, unknown>).providers === null
    ) {
      return emptyFile()
    }
    return {
      version: 1,
      providers: (parsed as ProvidersFile).providers,
    }
  } catch {
    return emptyFile() // ENOENT / malformed → empty
  }
}

/**
 * Read a single provider's stored api key from `providers.json`, or undefined
 * when the provider has no entry (or the file doesn't exist). The EXPLICIT,
 * verifiable credential source for the billing-auth resolver's api-key mode
 * (`agentproto auth provider set <provider> <key>` writes it) — distinct from
 * the ambient shell env, which the resolver never reads. Returns the raw key;
 * only a non-secret fingerprint of it is ever surfaced back to a caller.
 */
export async function getProviderKey(provider: string): Promise<string | undefined> {
  const file = await loadProviders()
  const entry = file.providers[provider]
  return entry?.apiKey || undefined
}

async function writeProviders(file: ProvidersFile): Promise<void> {
  const dir = join(homedir(), ".agentproto")
  await mkdir(dir, { recursive: true })
  // mode 0600 so other local users can't read the keys.
  await writeFile(providersPath(), JSON.stringify(file, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
}

/** Set (or replace) a provider's key. Returns the env-var it maps to. */
export async function setProviderKey(
  provider: string,
  apiKey: string,
  baseUrl?: string,
): Promise<string> {
  const file = await loadProviders()
  file.providers[provider] = {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    updatedAt: new Date().toISOString(),
  }
  await writeProviders(file)
  return providerEnvVar(provider)
}

/** Remove a provider's key. Returns true if it existed. */
export async function removeProviderKey(provider: string): Promise<boolean> {
  const file = await loadProviders()
  if (!(provider in file.providers)) return false
  delete file.providers[provider]
  await writeProviders(file)
  return true
}

/**
 * Inject stored provider keys into a target env (default `process.env`).
 * **Explicit env always wins** — a var already set is never overwritten, so a
 * one-off `FOO_API_KEY=… serve` or a CI secret takes precedence over the
 * store. One provider key is written to its canonical env name AND every
 * verified alias ({@link providerEnvAliases}) — so a consumer that reads a
 * different env name for the same provider (e.g. mastracode reads
 * `GOOGLE_API_KEY`, not our canonical `GOOGLE_GENERATIVE_AI_API_KEY`) is
 * satisfied too. Returns the list of provider names actually injected (for a
 * boot log that names providers, never values) — one entry per provider, not
 * per env name.
 */
export async function injectProviderKeysIntoEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const file = await loadProviders()
  const injected: string[] = []
  for (const [provider, entry] of Object.entries(file.providers)) {
    if (!entry?.apiKey) continue
    // Canonical name first, then any verified aliases the same key satisfies.
    // De-dupe defends against an alias that equals the canonical name.
    const names = new Set([providerEnvVar(provider), ...providerEnvAliases(provider)])
    let didInject = false
    for (const name of names) {
      if (env[name]) continue // explicit env wins — evaluated per env name
      env[name] = entry.apiKey
      didInject = true
    }
    if (!didInject) continue // every name for this provider is already set
    if (entry.baseUrl) env[`${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BASE_URL`] = entry.baseUrl
    injected.push(provider)
  }
  return injected
}
