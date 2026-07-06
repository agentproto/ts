/**
 * `agentproto auth <login | status | logout>`
 *
 * Implements the **host-binding** flow — the JWT that authenticates
 * `agentproto serve --connect <host>` to its tunnel host (Guilde,
 * a self-hosted gateway, …). Different from per-adapter setup tokens,
 * which are per-CLI and live in adapter `setup[]` blocks.
 *
 * Mechanism: OAuth 2.0 Device Authorization Grant (RFC 8628), the same
 * flow Claude Code, gh, gcloud, and stripe-cli use — via `@agentproto/auth`'s
 * `device-code` flow engine (AIP-50). `login` builds a transient
 * per-host auth-provider handle and calls `runAuthFlow`, which:
 *
 *   1. Discovers the device + token endpoints (OAuth PRM chain, falling
 *      back to `<host>/.well-known/agentproto-host.json`).
 *   2. POSTs the device-authorization endpoint, prints the user code +
 *      verification URL, best-effort-opens a browser.
 *   3. Polls the token endpoint until approved, then persists the
 *      credential through `CredentialsJsonStore` (../util/credentials-store.ts)
 *      to `~/.agentproto/credentials.json`.
 *
 * Everything else in `agentproto` (serve, install, run) treats this
 * file as the source of truth when no `--token` is supplied.
 */

import { hostname, userInfo } from "node:os"
import { parseArgs } from "node:util"
import {
  credentialsPath,
  deleteHost,
  formatExpiry,
  isExpired,
  loadCredentials,
  normaliseHost,
  readHost,
} from "../util/credentials.js"
import { CredentialsJsonStore } from "../util/credentials-store.js"
import { buildTunnelAuthProvider, toHttpHost } from "../util/tunnel-auth-provider.js"
import {
  runAuthFlow,
  KeychainStore,
  resolveStoreRef,
  type AuthProviderHandle,
  type CredentialStore,
} from "@agentproto/auth"
import {
  authProvidersPath,
  buildBrokerProvider,
  defaultTokenStore,
  loadAuthProviders,
  removeAuthProviderDef,
  setAuthProviderDef,
} from "../util/auth-providers-store.js"
import {
  loadProviders,
  setProviderKey,
  removeProviderKey,
  providerEnvVar,
  providersPath,
  PROVIDER_ENV_VARS,
} from "@agentproto/runtime/providers-store"
import {
  hasProviderCatalog,
  refreshProviderCatalog,
} from "../provider-catalog.js"

export async function runAuth(args: readonly string[]): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case "login":
      return runAuthLogin(rest)
    case "status":
      return runAuthStatus(rest)
    case "logout":
      return runAuthLogout(rest)
    case "provider":
      return runAuthProvider(rest)
    case "cred":
      return runAuthCred(rest)
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(
        `agentproto auth: unknown subcommand '${sub}'.\n\n${USAGE}`
      )
      return 2
  }
}

const USAGE = `agentproto auth — host-binding tokens (RFC 8628 device flow)

Usage:
  agentproto auth login   [--host <url>] [--label <name>] [--no-browser]
  agentproto auth status  [--host <url>] [--json]
  agentproto auth logout  [--host <url>]
  agentproto auth provider <set|list|rm> …   — LLM provider API keys
  agentproto auth cred     <set|list|rm> …   — broker creds for child-MCP auth

The default host is the one most recently logged into; on first use,
\`--host\` is required. Examples:

  agentproto auth login --host wss://guilde.work
  agentproto auth status
  agentproto auth logout --host wss://guilde.work

  agentproto auth provider set anthropic sk-ant-…
  agentproto auth provider set openrouter sk-or-… --base-url https://…
  agentproto auth provider list [--json]
  agentproto auth provider rm openai
`

const PROVIDER_USAGE = `agentproto auth provider — LLM provider API keys

Stored 0600 in ~/.agentproto/providers.json and injected into the daemon's
env at \`serve\` boot, so every spawned agent (mastra-agent, hermes, …) can
reach the provider. Explicit env (FOO_API_KEY=… serve) always wins.

Usage:
  agentproto auth provider set <provider> <api-key> [--base-url <url>]
  agentproto auth provider list [--json]
  agentproto auth provider rm  <provider>

Known providers (env var): ${Object.entries(PROVIDER_ENV_VARS)
  .map(([p, e]) => `${p} (${e})`)
  .join(", ")}.
Any other name works too — it maps to <NAME>_API_KEY.
`

// ── provider keys ────────────────────────────────────────────────────

async function runAuthProvider(args: readonly string[]): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case "set":
      return runProviderSet(rest)
    case "list":
    case "ls":
      return runProviderList(rest)
    case "rm":
    case "remove":
    case "delete":
      return runProviderRm(rest)
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(PROVIDER_USAGE)
      return 0
    default:
      process.stderr.write(
        `agentproto auth provider: unknown subcommand '${sub}'.\n\n${PROVIDER_USAGE}`,
      )
      return 2
  }
}

async function runProviderSet(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: { "base-url": { type: "string" } },
  })
  const [provider, apiKey] = positionals
  if (!provider || !apiKey) {
    process.stderr.write(
      `agentproto auth provider set: usage: set <provider> <api-key> [--base-url <url>]\n`,
    )
    return 2
  }
  const envVar = await setProviderKey(provider, apiKey, values["base-url"])
  process.stdout.write(
    `agentproto auth: ✓ stored ${provider} key → ${envVar}\n` +
      `  saved to ${providersPath()} (mode 0600)\n` +
      `  the daemon injects it at \`serve\` boot; restart a running daemon to pick it up.\n`,
  )

  // Eager live-on-setup catalog fetch: if this provider exposes an
  // account-specific catalog (voices), pull it now so the overlay is ready at
  // the next `serve` boot. Non-fatal — a bad key / offline only skips the
  // overlay; the committed baseline still serves.
  if (hasProviderCatalog(provider)) {
    try {
      const result = await refreshProviderCatalog(
        provider,
        apiKey,
        values["base-url"],
      )
      if (result) {
        process.stdout.write(
          result.skipped
            ? `  ✓ ${provider} catalog unchanged — ${result.count} voices cached\n`
            : `  ✓ fetched ${provider} catalog — ${result.count} voices → ${result.path}\n`,
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stdout.write(
        `  ⚠ could not fetch ${provider} catalog (${msg}); the committed baseline still serves.\n`,
      )
    }
  }
  return 0
}

async function runProviderList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: { json: { type: "boolean" } },
  })
  const file = await loadProviders()
  const entries = Object.entries(file.providers)
  if (values.json) {
    // Never emit key material — only metadata.
    process.stdout.write(
      JSON.stringify(
        {
          providers: entries.map(([provider, e]) => ({
            provider,
            envVar: providerEnvVar(provider),
            baseUrl: e.baseUrl ?? null,
            updatedAt: e.updatedAt,
            inEnv: Boolean(process.env[providerEnvVar(provider)]),
          })),
        },
        null,
        2,
      ) + "\n",
    )
    return 0
  }
  if (entries.length === 0) {
    process.stdout.write(
      `agentproto auth provider: no keys stored. Add one:\n` +
        `  agentproto auth provider set anthropic sk-ant-…\n`,
    )
    return 0
  }
  for (const [provider, e] of entries) {
    const envVar = providerEnvVar(provider)
    const live = process.env[envVar] ? " · live in this env" : ""
    const masked = maskKey(e.apiKey)
    process.stdout.write(
      `✓ ${provider}  → ${envVar}  ${masked}${live}\n` +
        (e.baseUrl ? `     base-url: ${e.baseUrl}\n` : "") +
        `     set ${e.updatedAt}\n`,
    )
  }
  return 0
}

async function runProviderRm(args: readonly string[]): Promise<number> {
  const provider = args[0]
  if (!provider) {
    process.stderr.write(`agentproto auth provider rm: usage: rm <provider>\n`)
    return 2
  }
  const existed = await removeProviderKey(provider)
  process.stdout.write(
    existed
      ? `agentproto auth: ✓ removed ${provider} key\n`
      : `agentproto auth: no stored key for ${provider}\n`,
  )
  return 0
}

/** Show only enough of a key to recognise it; never the full secret. */
function maskKey(key: string): string {
  if (key.length <= 10) return "••••"
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

// ── broker creds (child-MCP auth) ─────────────────────────────────────

const CRED_USAGE = `agentproto auth cred — broker credentials for child-MCP auth

A brokered credential lets a spawned agent mount a Bearer-gated MCP server
without the secret ever touching its config: store the token here, then spawn
with mcpServers:[{ …, credentialRef:"<id>" }] — the daemon's CredentialBroker
resolves the Authorization header at spawn. The def is saved to
~/.agentproto/auth-providers.json (0600) and re-registered at every serve boot;
the token itself lives in the OS keychain.

Usage:
  agentproto auth cred set <id> <token> --api-base <url> [--audience <aud>] [--description <text>]
  agentproto auth cred list [--json]
  agentproto auth cred rm  <id>

--audience defaults to "mcp" (what the daemon requests for child-MCP creds).
Restart a running daemon after set/rm to pick up the change.
`

async function runAuthCred(args: readonly string[]): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case "set":
      return runCredSet(rest)
    case "list":
    case "ls":
      return runCredList(rest)
    case "rm":
    case "remove":
    case "delete":
      return runCredRm(rest)
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(CRED_USAGE)
      return 0
    default:
      process.stderr.write(
        `agentproto auth cred: unknown subcommand '${sub}'.\n\n${CRED_USAGE}`,
      )
      return 2
  }
}

async function runCredSet(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: {
      "api-base": { type: "string" },
      audience: { type: "string" },
      description: { type: "string" },
    },
  })
  const [id, token] = positionals
  const apiBase = values["api-base"]
  if (!id || !token || !apiBase) {
    process.stderr.write(
      `agentproto auth cred set: usage: set <id> <token> --api-base <url> ` +
        `[--audience <aud>] [--description <text>]\n`,
    )
    return 2
  }
  const audience = values.audience ?? "mcp"
  const tokenStore = defaultTokenStore(id)

  // Build the handle up front: validates the def against the AIP-50 schema AND
  // derives the exact store ref the broker reads at spawn — so the key we write
  // here is, by construction, the key `resolveHeaders` looks up.
  let provider: AuthProviderHandle
  try {
    provider = buildBrokerProvider(id, {
      apiBase,
      audience,
      description: values.description,
      tokenStore,
    })
  } catch (err) {
    process.stderr.write(
      `agentproto auth cred set: invalid def — ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    )
    return 2
  }

  const ref = resolveStoreRef(
    provider.auth.tokenStore,
    provider.apiBase,
    provider.audience,
  )
  await new KeychainStore().write(ref, { value: token, kind: "pat" })
  const path = await setAuthProviderDef(
    id,
    { apiBase, audience, flow: "pat", description: values.description, tokenStore },
    new Date().toISOString(),
  )
  process.stdout.write(
    `agentproto auth: ✓ stored ${id} broker credential (audience "${audience}")\n` +
      `  token → OS keychain (${ref.path})\n` +
      `  def   → ${path} (mode 0600)\n` +
      `  mount it: agent_start mcpServers:[{ …, credentialRef:"${id}" }] — ` +
      `restart a running daemon first.\n`,
  )
  return 0
}

async function runCredList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: { json: { type: "boolean" } },
  })
  const file = await loadAuthProviders()
  const entries = Object.entries(file.providers)
  if (values.json) {
    // Metadata only — the token never lives in this file, so nothing to redact.
    process.stdout.write(
      JSON.stringify(
        {
          providers: entries.map(([id, e]) => ({
            id,
            audience: e.audience,
            apiBase: e.apiBase,
            flow: e.flow,
            updatedAt: e.updatedAt,
          })),
        },
        null,
        2,
      ) + "\n",
    )
    return 0
  }
  if (entries.length === 0) {
    process.stdout.write(
      `No broker credentials. Add one:\n` +
        `  agentproto auth cred set <id> <token> --api-base <url>\n`,
    )
    return 0
  }
  process.stdout.write(`Broker credentials (${authProvidersPath()}):\n`)
  for (const [id, e] of entries) {
    process.stdout.write(
      `  ${id}  audience=${e.audience}  ${e.apiBase}  (set ${e.updatedAt})\n`,
    )
  }
  return 0
}

async function runCredRm(args: readonly string[]): Promise<number> {
  const id = args[0]
  if (!id) {
    process.stderr.write(`agentproto auth cred rm: usage: rm <id>\n`)
    return 2
  }
  const file = await loadAuthProviders()
  const entry = file.providers[id]
  // Best-effort keychain delete, using the SAME ref derivation as set/read so
  // we target the exact stored key. The macOS KeychainStore has no delete
  // backend — there the token is left, but it's inert once the def is removed
  // (the broker throws on an unregistered id) and overwritten on re-add.
  let tokenCleared = false
  if (entry) {
    try {
      const provider = buildBrokerProvider(id, entry)
      const ref = resolveStoreRef(
        provider.auth.tokenStore,
        provider.apiBase,
        provider.audience,
      )
      const store: CredentialStore = new KeychainStore()
      if (store.delete) {
        await store.delete(ref)
        tokenCleared = true
      }
    } catch {
      /* keychain miss / no delete backend — fall through to def removal */
    }
  }
  const existed = await removeAuthProviderDef(id)
  process.stdout.write(
    existed
      ? `agentproto auth: ✓ removed ${id} broker credential ${
          tokenCleared
            ? "(def + keychain token)"
            : "(def; keychain token left — inert once de-registered)"
        }\n`
      : `agentproto auth: no broker credential for ${id}\n`,
  )
  return 0
}

// ── login ────────────────────────────────────────────────────────────

interface HostDiscovery {
  /** RFC 8414 issuer string, surfaced for "logged in to X" UI. */
  issuer: string
  /** RFC 8628 device authorization endpoint. */
  device_authorization_endpoint: string
  /** RFC 6749 token endpoint. */
  token_endpoint: string
  /** Optional revocation endpoint (RFC 7009). */
  revocation_endpoint?: string
  /** OAuth client_id the agentproto CLI presents. Hosts that don't
   *  enforce per-client metadata MAY return the constant
   *  `agentproto-cli`; hosts that do MUST register the CLI as a
   *  public client and put the registered id here. */
  client_id: string
  /** Optional scopes the CLI may request. Subset of host's offer. */
  scopes_supported?: string[]
}

async function runAuthLogin(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      host: { type: "string" },
      label: { type: "string" },
      "no-browser": { type: "boolean" },
      scope: { type: "string" },
    },
  })
  const host = values.host ?? (await pickDefaultHost())
  if (!host) {
    process.stderr.write(
      "agentproto auth login: pass --host <url> on first login (e.g. --host wss://guilde.work).\n"
    )
    return 2
  }
  const label = values.label ?? `${userInfo().username}@${hostname()}`
  const requestedScope = values.scope ?? "tunnel:connect agent-cli:dispatch"
  const normalizedHost = normaliseHost(host)
  const httpHost = toHttpHost(host)

  // A transient, per-host auth-provider handle — built fresh on every login
  // rather than registered, since the host is whatever `--host`/the config
  // says today. `runAuthFlow` does discovery (PRM chain, then
  // agentproto-host.json) and dispatches to the device-code engine, which
  // prints the user code + verification URL and polls to completion.
  const provider = buildTunnelAuthProvider(host, {
    label,
    scope: requestedScope,
  })

  process.stdout.write(`agentproto auth: logging in to ${normalizedHost}…\n`)
  try {
    await runAuthFlow(provider, {
      server: httpHost,
      store: new CredentialsJsonStore(),
      force: true,
      openBrowser: !values["no-browser"],
    })
  } catch (err) {
    process.stderr.write(
      `agentproto auth: login failed: ${err instanceof Error ? err.message : String(err)}\n`
    )
    return 1
  }

  const cred = await readHost(host)
  if (!cred) {
    process.stderr.write(
      `agentproto auth: login appeared to succeed, but no credential was persisted for ${normalizedHost}.\n`
    )
    return 1
  }
  process.stdout.write(
    `agentproto auth: ✓ logged in to ${normalizedHost}\n` +
      `  saved to ${credentialsPath()} (mode 0600)\n` +
      `  ${formatExpiry(cred)}${cred.subject ? `, subject ${cred.subject}` : ""}\n`
  )
  return 0
}

// ── status ───────────────────────────────────────────────────────────

async function runAuthStatus(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      host: { type: "string" },
      json: { type: "boolean" },
    },
  })
  const file = await loadCredentials()
  const entries = Object.entries(file.hosts)
  if (entries.length === 0) {
    if (values.json) {
      process.stdout.write(`{"hosts": []}\n`)
    } else {
      process.stdout.write(
        `agentproto auth: no credentials. Try: agentproto auth login --host wss://guilde.work\n`
      )
    }
    return 0
  }
  const filtered = values.host
    ? entries.filter(([h]) => h === normaliseHost(values.host!))
    : entries
  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          hosts: filtered.map(([host, c]) => ({
            host,
            subject: c.subject ?? null,
            scope: c.scope ?? null,
            obtainedAt: c.obtainedAt,
            expiresAt: c.expiresAt,
            expired: isExpired(c),
            deviceLabel: c.deviceLabel ?? null,
          })),
        },
        null,
        2
      ) + "\n"
    )
    return 0
  }
  for (const [host, c] of filtered) {
    const status = isExpired(c) ? "✗ EXPIRED" : "✓ active"
    process.stdout.write(
      `${status}  ${host}\n` +
        `         subject: ${c.subject ?? "(none)"}\n` +
        `         scope:   ${c.scope ?? "(none)"}\n` +
        `         label:   ${c.deviceLabel ?? "(none)"}\n` +
        `         ${formatExpiry(c)}  (obtained ${c.obtainedAt})\n`
    )
  }
  return 0
}

// ── logout ───────────────────────────────────────────────────────────

async function runAuthLogout(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: { host: { type: "string" } },
  })
  const host = values.host ?? (await pickDefaultHost())
  if (!host) {
    process.stderr.write(
      `agentproto auth logout: no credentials to revoke. Pass --host <url> if you stored one.\n`
    )
    return 0
  }
  const prev = await readHost(host)
  if (!prev) {
    process.stderr.write(
      `agentproto auth logout: no credential found for ${host}.\n`
    )
    return 0
  }

  // Best-effort server-side revocation. RFC 7009 token revocation is
  // optional in the host metadata; when missing, we just delete the
  // local copy. When present, we call it but don't fail logout if it
  // errors — the local delete still happens so the user is logged out
  // on this machine even if the host is unreachable.
  let serverRevoked: "ok" | "skipped" | "failed" = "skipped"
  try {
    const httpHost = toHttpHost(host)
    const discovery = await fetchJson<HostDiscovery>(
      `${httpHost}/.well-known/agentproto-host.json`
    )
    if (discovery.revocation_endpoint) {
      const params: Record<string, string> = {
        client_id: discovery.client_id,
        token: prev.token,
      }
      if (prev.revocationId) params["revocation_id"] = prev.revocationId
      await postForm(discovery.revocation_endpoint, params)
      serverRevoked = "ok"
    }
  } catch {
    serverRevoked = "failed"
  }

  await deleteHost(host)
  const note =
    serverRevoked === "ok"
      ? " (server revoked)"
      : serverRevoked === "failed"
        ? " (server revocation failed; local copy still removed)"
        : " (no revocation endpoint advertised; local copy removed)"
  process.stdout.write(`agentproto auth: ✓ logged out of ${host}${note}\n`)
  return 0
}

// ── helpers ──────────────────────────────────────────────────────────

async function pickDefaultHost(): Promise<string | null> {
  const f = await loadCredentials()
  const keys = Object.keys(f.hosts)
  if (keys.length === 0) return null
  // Most-recently-issued wins. Status command surfaces the full list
  // so the heuristic is just for omitted --host on a single-host setup.
  let best: { host: string; obtainedAt: number } | null = null
  for (const [host, cred] of Object.entries(f.hosts)) {
    const t = Date.parse(cred.obtainedAt)
    if (!Number.isFinite(t)) continue
    if (!best || t > best.obtainedAt) best = { host, obtainedAt: t }
  }
  return best?.host ?? keys[0] ?? null
}


async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } })
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

async function postForm<T>(
  url: string,
  body: Record<string, string>
): Promise<T> {
  const params = new URLSearchParams(body)
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  })
  // OAuth error responses return 400 with a JSON `{error, ...}` body.
  // Hand them back to the caller verbatim; let it discriminate.
  if (!res.ok && res.status !== 400) {
    const text = await res.text().catch(() => "")
    throw new Error(
      `POST ${url} → ${res.status} ${res.statusText}${text ? ": " + text.slice(0, 200) : ""}`
    )
  }
  return (await res.json()) as T
}
