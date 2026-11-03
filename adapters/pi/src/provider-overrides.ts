/**
 * Per-session pi provider overrides for OpenCode console sub-accounts.
 *
 * A Go profile pinned to a console org (`source: "opencode-console"`) is
 * resolved by the opencode adapter's registered sub-account provider
 * (`@agentproto/adapter-opencode` `subaccounts.ts`), not here: the spawn env
 * already carries the console bearer in `OPENCODE_CONSOLE_TOKEN` and the
 * org's provider block in `OPENCODE_CONFIG_CONTENT`
 * (`{"provider":{"opencode-go":{"options":{"apiKey":"{env:OPENCODE_CONSOLE_TOKEN}",
 * "headers":{"x-opencode-org-id":"org_..."}}}}}`). opencode reads that block
 * natively; pi does not, and with no `OPENCODE_API_KEY` it fails with "No API
 * key found for opencode-go". This module translates the block into pi's own
 * provider-override shape (the `models.json` `providers.<name>` fields
 * `apiKey` + `headers`, see pi's docs/models.md), which the shipped extension
 * (`provider-overrides-extension.mjs`, loaded via `-e`) hands to
 * `pi.registerProvider()`. An override with only apiKey/headers keeps every
 * built-in model of the provider and its own baseUrl.
 *
 * The written config never holds a secret: credentials stay in the child env
 * and the config names them as pi `$ENV` references. A literal apiKey in the
 * block is moved into a dedicated env var first.
 *
 * `x-opencode-session` is NOT set here: pi 0.80.x already sends
 * `x-opencode-session: <pi session id>` and `x-opencode-client: pi` on every
 * `opencode` / `opencode-go` request (`core/provider-attribution.js`), and an
 * override header would replace that stable per-conversation id.
 */

import { writeFileSync } from "node:fs"
import { join } from "node:path"

/** Env var the extension reads to find its per-session config JSON. */
export const PROVIDER_OVERRIDES_CONFIG_ENV = "PI_PROVIDER_OVERRIDES_CONFIG"

/** The opencode inline config var a console-org profile's provider block rides in. */
export const OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT"

/** Where the opencode console sub-account resolution puts the org-scoped bearer. */
export const OPENCODE_CONSOLE_TOKEN_ENV = "OPENCODE_CONSOLE_TOKEN"

/** Pi's built-in provider ids for OpenCode Zen and OpenCode Go (same spelling as opencode's). */
export const OPENCODE_PI_PROVIDERS = ["opencode", "opencode-go"] as const

export interface PiProviderOverride {
  /** Pi config value: always a `$ENV` reference here, never a literal key. */
  apiKey?: string
  headers?: Record<string, string>
}

export interface PiProviderOverridesConfig {
  providers: Record<string, PiProviderOverride>
}

export interface BuiltProviderOverrides {
  config: PiProviderOverridesConfig
  /** Env to add to the child beside the config (relocated literal keys). */
  env: Record<string, string>
}

const OPENCODE_ENV_REF_RE = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A pi `$ENV` reference to `name`. */
function piEnvRef(name: string): string {
  return `\${${name}}`
}

/**
 * Escape a literal for pi's config-value resolver: `$` starts an env
 * interpolation and a leading `!` runs a shell command, so a header value
 * from a remote config must never reach pi unescaped.
 */
export function escapePiConfigLiteral(value: string): string {
  const escaped = value.replaceAll("$", "$$$$")
  return escaped.startsWith("!") ? `$${escaped}` : escaped
}

/** opencode `{env:NAME}` → pi `${NAME}`; anything else → an escaped literal. */
function translateValue(value: string): string {
  const ref = OPENCODE_ENV_REF_RE.exec(value)
  return ref ? piEnvRef(ref[1]!) : escapePiConfigLiteral(value)
}

function relocatedKeyEnv(provider: string): string {
  return `AGENTPROTO_PI_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`
}

/**
 * Translate the console-org provider block found in `env` into pi provider
 * overrides. `undefined` when the env carries no block for an OpenCode
 * provider (every non-sub-account spawn).
 */
export function buildOpencodeProviderOverrides(
  env: Record<string, string | undefined>,
): BuiltProviderOverrides | undefined {
  const raw = env[OPENCODE_CONFIG_CONTENT_ENV]
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !isRecord(parsed.provider)) return undefined

  const providers: Record<string, PiProviderOverride> = {}
  const extraEnv: Record<string, string> = {}
  for (const name of OPENCODE_PI_PROVIDERS) {
    const block = parsed.provider[name]
    if (!isRecord(block)) continue
    const options = isRecord(block.options) ? block.options : {}
    const override: PiProviderOverride = {}

    const apiKey = options.apiKey
    const apiKeyRef = typeof apiKey === "string" ? OPENCODE_ENV_REF_RE.exec(apiKey) : null
    if (apiKeyRef) {
      override.apiKey = piEnvRef(apiKeyRef[1]!)
    } else if (typeof apiKey === "string" && apiKey.length > 0 && !apiKey.startsWith("{")) {
      const envName = relocatedKeyEnv(name)
      extraEnv[envName] = apiKey
      override.apiKey = piEnvRef(envName)
    } else if (env[OPENCODE_CONSOLE_TOKEN_ENV]) {
      override.apiKey = piEnvRef(OPENCODE_CONSOLE_TOKEN_ENV)
    }

    if (isRecord(options.headers)) {
      const headers: Record<string, string> = {}
      for (const [header, value] of Object.entries(options.headers)) {
        if (typeof value === "string") headers[header] = translateValue(value)
      }
      if (Object.keys(headers).length > 0) override.headers = headers
    }

    if (override.apiKey !== undefined || override.headers !== undefined) {
      providers[name] = override
    }
  }

  if (Object.keys(providers).length === 0) return undefined
  return { config: { providers }, env: extraEnv }
}

/** Write the config into `dir` and return its path. */
export function writeProviderOverridesConfig(dir: string, config: PiProviderOverridesConfig): string {
  const path = join(dir, "provider-overrides.json")
  writeFileSync(path, JSON.stringify(config), { encoding: "utf8", mode: 0o600 })
  return path
}

/** Validate a parsed config (the extension's read side): keep only string fields. */
export function parseProviderOverridesConfig(value: unknown): PiProviderOverridesConfig {
  const providers: Record<string, PiProviderOverride> = {}
  if (!isRecord(value) || !isRecord(value.providers)) return { providers }
  for (const [name, entry] of Object.entries(value.providers)) {
    if (!isRecord(entry)) continue
    const override: PiProviderOverride = {}
    if (typeof entry.apiKey === "string") override.apiKey = entry.apiKey
    if (isRecord(entry.headers)) {
      const headers: Record<string, string> = {}
      for (const [header, v] of Object.entries(entry.headers)) {
        if (typeof v === "string") headers[header] = v
      }
      override.headers = headers
    }
    providers[name] = override
  }
  return { providers }
}
