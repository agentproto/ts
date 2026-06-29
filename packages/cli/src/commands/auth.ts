/**
 * `agentproto auth <login | status | logout>`
 *
 * Implements the **host-binding** flow — the JWT that authenticates
 * `agentproto serve --connect <host>` to its tunnel host (Guilde,
 * a self-hosted gateway, …). Different from per-adapter setup tokens,
 * which are per-CLI and live in adapter `setup[]` blocks.
 *
 * Mechanism: OAuth 2.0 Device Authorization Grant (RFC 8628), the
 * same flow Claude Code, gh, gcloud, and stripe-cli use. Three steps:
 *
 *   1. Discovery   — fetch `<host>/.well-known/agentproto-host.json`
 *                    to learn the device + token endpoints.
 *   2. Authorize   — POST device endpoint → user_code + verification_uri.
 *   3. Poll        — POST token endpoint with grant_type=device_code
 *                    until the user approves in the browser, then
 *                    persist {access_token, refresh_token, expires_in}
 *                    to `~/.agentproto/credentials.json`.
 *
 * Everything else in `agentproto` (serve, install, run) treats this
 * file as the source of truth when no `--token` is supplied.
 */

import { spawn } from "node:child_process"
import { hostname, platform, userInfo } from "node:os"
import { parseArgs } from "node:util"
import {
  credentialsPath,
  deleteHost,
  formatExpiry,
  isExpired,
  loadCredentials,
  normaliseHost,
  readHost,
  writeHost,
  type HostCredential,
} from "../util/credentials.js"
import {
  loadProviders,
  setProviderKey,
  removeProviderKey,
  providerEnvVar,
  providersPath,
  PROVIDER_ENV_VARS,
} from "@agentproto/runtime/providers-store"

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

interface DeviceAuthResponse {
  device_code: string
  user_code: string
  verification_uri: string
  /** Optional pre-filled URL with the user_code embedded. RFC 8628 §3.3.1. */
  verification_uri_complete?: string
  expires_in: number
  /** Polling interval in seconds. RFC 8628 default 5. */
  interval?: number
}

interface TokenSuccessResponse {
  access_token: string
  token_type: "Bearer" | "bearer"
  expires_in: number
  refresh_token?: string
  scope?: string
  /** Custom (not in RFC 6749): host's revocation hint, e.g. JTI or
   *  internal token row id. We pass it back on logout. */
  revocation_id?: string
  /** Custom: subject id surfaced in `auth status`. */
  subject?: string
}

interface TokenErrorResponse {
  error:
    | "authorization_pending"
    | "slow_down"
    | "access_denied"
    | "expired_token"
    | "invalid_client"
    | "invalid_grant"
    | "unsupported_grant_type"
    | string
  error_description?: string
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

  const httpHost = toHttp(host)
  const discoveryUrl = `${httpHost}/.well-known/agentproto-host.json`
  process.stdout.write(`agentproto auth: discovering ${discoveryUrl}\n`)
  let discovery: HostDiscovery
  try {
    discovery = await fetchJson<HostDiscovery>(discoveryUrl)
  } catch (err) {
    process.stderr.write(
      `agentproto auth: failed to fetch host metadata: ${err instanceof Error ? err.message : String(err)}\n` +
        `  Hosts SHOULD expose /.well-known/agentproto-host.json with device_authorization_endpoint + token_endpoint.\n`
    )
    return 1
  }

  // Step 1 — request a device code.
  let deviceRes: DeviceAuthResponse
  try {
    deviceRes = await postForm<DeviceAuthResponse>(
      discovery.device_authorization_endpoint,
      {
        client_id: discovery.client_id,
        scope: requestedScope,
        // Custom field; hosts that ignore it stay compliant. The
        // approval UI uses it to render "approve <label>" so the user
        // recognises the device they're authorising.
        device_label: label,
      }
    )
  } catch (err) {
    process.stderr.write(
      `agentproto auth: device authorization request failed: ${err instanceof Error ? err.message : String(err)}\n`
    )
    return 1
  }

  // Step 2 — show the code, open the browser.
  const verifyUrl =
    deviceRes.verification_uri_complete ?? deviceRes.verification_uri
  process.stdout.write(
    `\nagentproto auth: open\n  ${verifyUrl}\nand enter code  ${deviceRes.user_code}\n\n`
  )
  if (!values["no-browser"]) {
    void openBrowser(verifyUrl)
  }
  process.stdout.write(
    `agentproto auth: waiting for approval (expires in ${formatDuration(deviceRes.expires_in * 1000)})…\n`
  )

  // Step 3 — poll the token endpoint.
  const interval = Math.max(1, deviceRes.interval ?? 5)
  const deadline = Date.now() + deviceRes.expires_in * 1000
  let pollIntervalMs = interval * 1000
  let token: TokenSuccessResponse | null = null
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs)
    let res: TokenSuccessResponse | TokenErrorResponse
    try {
      res = await postForm<TokenSuccessResponse | TokenErrorResponse>(
        discovery.token_endpoint,
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceRes.device_code,
          client_id: discovery.client_id,
        }
      )
    } catch (err) {
      process.stderr.write(
        `agentproto auth: token poll failed: ${err instanceof Error ? err.message : String(err)}\n`
      )
      return 1
    }
    if ("access_token" in res) {
      token = res
      break
    }
    if (res.error === "authorization_pending") continue
    if (res.error === "slow_down") {
      // Back off as RFC 8628 §3.5 recommends; poll cadence stays slower
      // for the rest of the flow.
      pollIntervalMs += 5_000
      continue
    }
    if (res.error === "access_denied") {
      process.stderr.write(`agentproto auth: approval denied. Aborting.\n`)
      return 1
    }
    if (res.error === "expired_token") {
      process.stderr.write(
        `agentproto auth: device code expired before approval. Re-run \`agentproto auth login\`.\n`
      )
      return 1
    }
    process.stderr.write(
      `agentproto auth: token endpoint returned '${res.error}'${
        res.error_description ? `: ${res.error_description}` : ""
      }\n`
    )
    return 1
  }
  if (!token) {
    process.stderr.write(
      `agentproto auth: timed out waiting for approval. Re-run \`agentproto auth login\`.\n`
    )
    return 1
  }

  // Persist.
  const cred: HostCredential = {
    token: token.access_token,
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    obtainedAt: new Date().toISOString(),
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    ...(token.scope ? { scope: token.scope } : {}),
    ...(token.subject ? { subject: token.subject } : {}),
    ...(token.revocation_id ? { revocationId: token.revocation_id } : {}),
    deviceLabel: label,
  }
  await writeHost(host, cred)
  process.stdout.write(
    `agentproto auth: ✓ logged in to ${normaliseHost(host)}\n` +
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
    const httpHost = toHttp(host)
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

/**
 * The host URL the user passes is typically a wss:// (tunnel) URL.
 * The OAuth metadata document lives at the http(s) origin of the same
 * host. This converter assumes wss → https, ws → http; everything
 * else passes through.
 */
function toHttp(host: string): string {
  const trimmed = host.replace(/\/+$/, "")
  if (trimmed.startsWith("wss://")) return "https://" + trimmed.slice(6)
  if (trimmed.startsWith("ws://")) return "http://" + trimmed.slice(5)
  return trimmed
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

function openBrowser(url: string): Promise<void> {
  // best-effort; failure is non-fatal — the URL is already on screen.
  const p = platform()
  const cmd = p === "darwin" ? "open" : p === "win32" ? "cmd" : "xdg-open"
  const args = p === "win32" ? ["/c", "start", url] : [url]
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true })
      child.once("error", () => resolve())
      child.once("spawn", () => {
        child.unref()
        resolve()
      })
    } catch {
      resolve()
    }
  })
}
