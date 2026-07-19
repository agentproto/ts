#!/usr/bin/env node
/**
 * Writes `defaults.adapters.<adapter>` into `~/.agentproto/config.json` so the
 * daemon this action boots resolves billing-auth AND per-spawn adapter options
 * for the spawn.
 *
 * Two independent config surfaces, both landing on disk (never in the ambient
 * shell env — see below), both read by the runtime for a spawn of this adapter:
 *
 *  1. `defaults.adapters.<slug>.auth` — the billing-auth material. The runtime's
 *     auth resolver (`packages/runtime/src/spawn-defaults.ts` →
 *     `resolveSpawnDefaults` / `resolveAuthSpec`) reads it; an exported
 *     CLAUDE_CODE_OAUTH_TOKEN in the calling workflow would be silently
 *     ignored, and `authEnforce: "always"` on claude-code fails the spawn fast
 *     with no credential. Written ONLY when a credential for the requested mode
 *     is present — a gateway/ambient row (no token, no key) leaves the adapter
 *     unauthenticated on purpose so a gateway `base_url` + bearer takes over.
 *
 *  2. `defaults.adapters.<slug>.options` — AIP-45 adapter options
 *     (`model` / `base_url` / `thinking`). `resolveSpawnDefaults` shallow-merges
 *     `defaults.adapters.<slug>.options` into the spawn's effective options
 *     (packages/runtime/src/session-spawn.ts), and `compose.ts` in
 *     `@agentproto/driver-agent-cli` renders each declared option's
 *     `bin_args_template` (`model` → `--model <id>`) / `env` (`base_url` →
 *     `ANTHROPIC_BASE_URL`) into the adapter subprocess's argv + env
 *     (define-agent-cli.ts merges `composed.env` over the child env). This is
 *     the config.json/adapter-options path the runtime already honors — the
 *     preferred way to drive a gateway model combo without touching ambient env.
 *
 * The provider KEY itself (e.g. a Moonshot bearer) is NOT written here: it goes
 * onto the daemon's own process env in driver.mjs (PROVIDER_KEY_ENV /
 * PROVIDER_KEY), because that is how the adapter reads the gateway credential
 * (claude-sdk's Anthropic SDK reads ANTHROPIC_AUTH_TOKEN from the child env,
 * which inherits the daemon env via `filterStringEnv(process.env)`).
 *
 * All values arrive via `env:` (never interpolated into a shell command
 * string) and are never logged.
 */

import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

function requireEnv(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`write-config: missing required env ${name}`)
    process.exit(1)
  }
  return v
}

const adapter = requireEnv("ADAPTER")
const mode = requireEnv("AUTH_MODE")
if (mode !== "subscription" && mode !== "api-key") {
  console.error(`write-config: auth-mode must be "subscription" or "api-key", got "${mode}"`)
  process.exit(1)
}

const token = process.env.OAUTH_TOKEN ?? ""
const apiKey = process.env.API_KEY ?? ""

// Optional AIP-45 adapter options (harness matrix knobs). Empty ⇒ absent.
const model = process.env.MODEL ?? ""
const baseUrl = process.env.BASE_URL ?? ""
const thinking = (process.env.THINKING ?? "").toLowerCase() === "true"

const options = {}
if (model) options.model = model
if (baseUrl) options.base_url = baseUrl
if (thinking) options.thinking = true
const hasOptions = Object.keys(options).length > 0

// Whether a credential for the requested mode is actually present. A gateway /
// ambient row deliberately passes neither (the gateway bearer rides the daemon
// env, and `base_url` targets a foreign host), so we must NOT fail on it — we
// simply skip the auth block and leave the adapter unauthenticated for native
// Anthropic, which is exactly what a `base_url` gateway spawn wants.
const hasCredential = mode === "subscription" ? Boolean(token) : Boolean(apiKey)

// Guard a genuine misconfiguration: a bare invocation that configures NOTHING
// (no credential, no options) is almost certainly a mistake — keep failing loud
// as the original did, rather than writing an empty adapter stanza.
if (!hasCredential && !hasOptions) {
  console.error(
    `write-config: nothing to configure for adapter "${adapter}" — auth-mode=${mode} ` +
      `supplied no ${mode === "subscription" ? "oauth-token" : "api-key"}, and no ` +
      `model/base-url/thinking option was given.`,
  )
  process.exit(1)
}

const configDir = join(homedir(), ".agentproto")
const configPath = join(configDir, "config.json")
await mkdir(configDir, { recursive: true })

let config = {}
if (existsSync(configPath)) {
  try {
    config = JSON.parse(await readFile(configPath, "utf8"))
  } catch (err) {
    console.error(`write-config: existing ${configPath} is not valid JSON: ${err.message}`)
    process.exit(1)
  }
}

config.defaults ??= {}
config.defaults.adapters ??= {}
config.defaults.adapters[adapter] ??= {}

const wrote = []
if (hasCredential) {
  config.defaults.adapters[adapter].auth =
    mode === "subscription" ? { mode, token } : { mode, apiKey }
  wrote.push(`auth (mode=${mode})`)
}
if (hasOptions) {
  config.defaults.adapters[adapter].options = {
    ...(config.defaults.adapters[adapter].options ?? {}),
    ...options,
  }
  // Log option KEYS only — model/base_url are non-secret, but never echo values
  // to keep this line uniformly safe.
  wrote.push(`options [${Object.keys(options).join(", ")}]`)
}

// ── Langfuse tracing (optional, all-or-nothing) ──────────────────────────
// When the three load-bearing LANGFUSE_* vars are present, write the same
// creds file `setup_eval_reporter` writes (~/.agentproto/eval-reporter-creds/
// langfuse.json) and flip `defaults.langfuseTracing` on, so the daemon this
// action boots traces its (single) reviewer session. The HOST daemon owns
// the proxied sandbox session, so IT emits the traces — the box needs
// nothing. Absent/partial creds ⇒ skip silently: tracing must never gate the
// review (and the tracer itself is soft-fail — flush errors are swallowed,
// so an unreachable Langfuse host degrades to no traces, never a red job).
const lfPublicKey = process.env.LANGFUSE_PUBLIC_KEY ?? ""
const lfSecretKey = process.env.LANGFUSE_SECRET_KEY ?? ""
const lfBaseUrl = process.env.LANGFUSE_BASE_URL ?? ""
const lfProject = process.env.LANGFUSE_PROJECT ?? ""
if (lfPublicKey && lfSecretKey && lfBaseUrl) {
  const credsDir = join(configDir, "eval-reporter-creds")
  await mkdir(credsDir, { recursive: true })
  const creds = {
    publicKey: lfPublicKey,
    secretKey: lfSecretKey,
    // The ingestion client joins `${baseUrl}/api/public/ingestion` — strip a
    // trailing slash so the path doesn't double up.
    baseUrl: lfBaseUrl.replace(/\/+$/, ""),
    // Langfuse "environment" tag on every trace — the project itself is
    // selected by the key pair; this is just the filterable label. Sanitized
    // to Langfuse's allowed charset (lowercase alphanumerics, -, _).
    environment: (lfProject || "github-ci").toLowerCase().replace(/[^a-z0-9-_]/g, "-"),
  }
  await writeFile(join(credsDir, "langfuse.json"), JSON.stringify(creds, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
  config.defaults.langfuseTracing = true
  wrote.push(`langfuse tracing (environment=${creds.environment})`)
} else if (lfPublicKey || lfSecretKey || lfBaseUrl) {
  console.log(
    "write-config: partial LANGFUSE_* env (need PUBLIC_KEY + SECRET_KEY + BASE_URL) — tracing skipped",
  )
}

await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
console.log(`write-config: wrote defaults.adapters.${adapter}.{${wrote.join(", ")}} to ${configPath}`)
