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

/**
 * Canonical provider → environment-variable name. The spawned model gateways
 * (Mastra in mastra-agent, hermes/opencode's routers) read the provider key
 * from these env names. Aligned with the adapter manifests' `models.env`
 * maps + the common SDK conventions.
 */
export const PROVIDER_ENV_VARS: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  // Vercel AI Gateway — a gateway provider, like openrouter, that fronts many
  // upstream model families behind one key.
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
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

export async function loadProviders(): Promise<ProvidersFile> {
  try {
    const raw = await readFile(providersPath(), "utf8")
    const parsed = JSON.parse(raw) as Partial<ProvidersFile>
    if (!parsed || typeof parsed !== "object" || !parsed.providers) return emptyFile()
    return { version: 1, providers: parsed.providers }
  } catch {
    return emptyFile() // ENOENT / malformed → empty
  }
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
 * store. Returns the list of provider names actually injected (for a boot log
 * that names providers, never values).
 */
export async function injectProviderKeysIntoEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const file = await loadProviders()
  const injected: string[] = []
  for (const [provider, entry] of Object.entries(file.providers)) {
    if (!entry?.apiKey) continue
    const name = providerEnvVar(provider)
    if (env[name]) continue // explicit env wins
    env[name] = entry.apiKey
    if (entry.baseUrl) env[`${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BASE_URL`] = entry.baseUrl
    injected.push(provider)
  }
  return injected
}
