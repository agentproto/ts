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

import { readFile } from "node:fs/promises"
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
  addAuthProfile,
  authProfilesPath,
  createAuthProfile,
  credentialIdentity,
  deleteAuthProfile,
  getAuthProfile,
  listAuthProfiles,
  refreshAuthProfileModels,
  removeAuthProfile,
  setAuthProfileEnabled,
  setAuthProfileModels,
  AuthProfileValidationError,
  type AuthProviderHandle,
  type AuthProfile,
  type CredentialStore,
  type ProfileProvisionDeps,
} from "@agentproto/auth"
import { getModelsByProvider } from "@agentproto/model-catalog"
import {
  discoverCredentials,
  importDiscoveredCredential,
  CredentialImportError,
  type DiscoveredCredential,
} from "@agentproto/runtime/credential-discovery"
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
  providerEnvAliases,
  providersPath,
  PROVIDER_ENV_VARS,
  PROVIDER_ENV_ALIASES,
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
    case "profile":
      return runAuthProfile(rest)
    case "discover":
      return runAuthDiscover(rest)
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
                          [--scope <scopes>]
  agentproto auth status  [--host <url>] [--json]
  agentproto auth logout  [--host <url>]
  agentproto auth provider <set|list|rm> …   — LLM provider API keys
  agentproto auth cred     <set|list|rm> …   — broker creds for child-MCP auth
                          set <id> <token> --api-base <url> [--audience <aud>]
                                             [--description <text>]
  agentproto auth profile <create|list|rm|import|set-models|
                           set-enabled|refresh-models> …
                          — named auth profiles (subscriptions / API keys)
                          create <id> <endpoint> --method <oauth-bearer|api-key>
                                 [--label <text>] [--source <name>]
                                 [--credential-file <path>] [--credential-env <VAR>]
                                 [--credential-ref <slot>] [--json]
                          list [--endpoint <e>] [--json]
                          rm <id>
                          import <origin> <endpoint> [--id <id>] [--label <text>]
                          set-models <id> <all|allow> [<ids…>]
                          set-enabled <id> <true|false>
                          refresh-models <id> [--json]
                          (the credential itself is NEVER a command-line
                           argument — pipe it on stdin, or name a file or
                           env var with --credential-file/--credential-env)
  agentproto auth discover [--endpoint <e>] [--json]
                          — scan this host for credentials you can import

The default host is the one most recently logged into; on first use,
\`--host\` is required.

  --scope <scopes>  space-separated scopes the device flow requests
                      (default: "tunnel:connect agent-cli:dispatch")

Examples:

  agentproto auth login --host wss://guilde.work
  agentproto auth status
  agentproto auth logout --host wss://guilde.work

  agentproto auth provider set anthropic sk-ant-…
  agentproto auth provider set openrouter sk-or-… --base-url https://…
  agentproto auth provider list [--json]
  agentproto auth provider rm openai

  agentproto auth discover
  op paste | agentproto auth profile create work-anthropic anthropic \
      --method oauth-bearer --label "work sub"
  agentproto auth profile create gateway-or --method api-key --credential-env OR_API_KEY
  agentproto auth profile list
  agentproto auth profile import claude-code anthropic
  agentproto auth profile set-enabled work-anthropic false
  agentproto auth profile set-models work-anthropic allow claude-code/claude-sonnet-4
  agentproto auth profile rm work-anthropic
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
  .map(([p, e]) => {
    const aliases = providerEnvAliases(p)
    return aliases.length ? `${p} (${e}, +${aliases.join(", +")})` : `${p} (${e})`
  })
  .join(", ")}.
Any other name works too — it maps to <NAME>_API_KEY.
A \`+ALIAS\` is an extra env name the same key is also injected as, for a
consumer that reads a different name for that provider.
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
  const aliases = providerEnvAliases(provider)
  process.stdout.write(
    `agentproto auth: ✓ stored ${provider} key → ${envVar}\n` +
      (aliases.length
        ? `  also injected as ${aliases.join(", ")} (alias some consumers read)\n`
        : "") +
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

// ── named auth profiles: curation refresh ──────────────────────────────

const PROFILE_USAGE = `agentproto auth profile — named auth-profile management

Named auth profiles (~/.agentproto/auth-profiles.json + OS keychain) attach a
subscription or API key to a stable id you bill spawns through
(\`agentproto sessions start <adapter> --access-profile <id>\`). These verbs
talk to the same on-disk store + keychain the daemon's MCP tools
(auth_profile_create, auth_profile_set_models, …) do — no running daemon
required, same as \`auth provider\` / \`auth cred\`.

Usage:
  agentproto auth profile create <id> <endpoint> --method <oauth-bearer|api-key>
                                 [--label <text>] [--source <name>]
                                 [--credential-file <path>] [--credential-env <VAR>]
                                 [--credential-ref <slot>] [--json]
  agentproto auth profile list|ls [--endpoint <e>] [--json]
  agentproto auth profile rm|remove|delete <id>
  agentproto auth profile import <origin> <endpoint> [--id <id>] [--label <text>]
  agentproto auth profile set-models <id> <all|allow> [<ids…>]
  agentproto auth profile set-enabled <id> <true|false>
  agentproto auth profile refresh-models <id> [--json]

🔒 The credential NEVER goes on the command line — a bare argument lands in
shell history and in \`ps\` output for every user on this machine. \`create\`
reads it from STDIN (pipe it in; on a TTY you get a hidden prompt), or from a
file / env var via --credential-file <path> / --credential-env <VAR_NAME>.
Those flags take the PATH or the VARIABLE NAME — never the secret itself.

create:
  --method oauth-bearer  a subscription bearer. With --source claude-code-oauth
                         the profile stores NO secret at all — the credential
                         is re-resolved from the local Claude Code login at
                         every spawn (exactly one of a piped credential or
                         --source).
  --method api-key       a vendor/gateway key — requires a credential.

  --credential-ref       explicit keychain slot; omitted ⇒ derived from
                         endpoint + method (qualified with <id> on collision).

list shows non-secret metadata only — plus, like auth_profile_list, a read-only
key identity per profile: keyStatus (stored / self-refreshing / unavailable)
and, for a stored secret, a one-way fingerprint + last4. Never the secret.

import <origin> materializes a credential discovered by
\`agentproto auth discover\` (origins: claude-code, hermes-config, env, codex,
gemini) into a named profile — source-backed where the origin self-refreshes,
a keychain COPY otherwise. The method is fixed by the origin.

set-models "all" services every eligible model and clears any allowlist;
"allow" narrows the profile to exactly the listed model ids (space- or
comma-separated catalog vendor/product or route-qualified refs).

set-enabled toggles a whole profile: a disabled one is skipped by the
eligibility predicate entirely (every model it would bill drops to
non-runnable). Metadata-only; the keychain credential is untouched.

refresh-models re-syncs a mode:"allow" allowlist against the CURRENT model
catalog for the profile's endpoint (new models ship, old ones retire).
Explicit and opt-in; refuses a mode:"all" profile (nothing to refresh).
`

/** Local, filesystem/keychain-only provisioning deps — mirrors
 *  `defaultProfileProvisionDeps()` in `packages/runtime/src/auth-profile-tools.ts`,
 *  duplicated here (rather than importing `@agentproto/runtime`, a devDependency
 *  not meant to ship in the published CLI) so this command works standalone,
 *  with no daemon required — same as `auth provider`/`auth cred` above. */
function localProfileProvisionDeps(): ProfileProvisionDeps {
  return {
    store: new KeychainStore(),
    getProfile: getAuthProfile,
    listProfiles: () => listAuthProfiles(),
    addProfile: addAuthProfile,
    removeProfile: removeAuthProfile,
  }
}

async function runAuthProfile(args: readonly string[]): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case "create":
      return runProfileCreate(rest)
    case "list":
    case "ls":
      return runProfileList(rest)
    case "rm":
    case "remove":
    case "delete":
      return runProfileRm(rest)
    case "import":
      return runProfileImport(rest)
    case "set-models":
      return runProfileSetModels(rest)
    case "set-enabled":
      return runProfileSetEnabled(rest)
    case "refresh-models":
      return runProfileRefreshModels(rest)
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(PROFILE_USAGE)
      return 0
    default:
      process.stderr.write(
        `agentproto auth profile: unknown subcommand '${sub}'.\n\n${PROFILE_USAGE}`,
      )
      return 2
  }
}

// ── named auth profiles: create / list / rm / import / curate ───────────

/** The DISCOVER_ORIGINS `import` accepts — mirrors the MCP
 *  `auth_profile_import` tool's z.enum and `@agentproto/runtime`'s
 *  `CredentialOrigin`. Kept as strings (not imported) so the CLI usage text
 *  can render them without touching runtime for the common help path. */
const IMPORT_ORIGINS = ["claude-code", "hermes-config", "env", "codex", "gemini"]

/** The stream a piped credential is read from — `process.stdin`, except in
 *  unit tests, where `process.stdin` is a getter that cannot be swapped. */
let secretInputStream: NodeJS.ReadableStream = process.stdin

/** Test seam for {@link secretInputStream}: point the piped-credential read
 *  at an in-memory stream. Pass `undefined` to restore `process.stdin`. */
export function setSecretInputStream(
  stream: NodeJS.ReadableStream | undefined,
): void {
  secretInputStream = stream ?? process.stdin
}

/** Read the credential from stdin. Piped stdin is read to EOF; a TTY gets a
 *  hidden prompt (raw mode, no echo) so the pasted secret never lands in
 *  terminal scrollback. The secret is returned trimmed — never logged, never
 *  echoed back. */
async function readSecretFromStdin(what: string): Promise<string> {
  const stdin = process.stdin
  if (stdin.isTTY) {
    return await promptHidden(`${what}, then press Enter (input hidden): `)
  }
  const chunks: Buffer[] = []
  for await (const chunk of secretInputStream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8").trim()
}

/** Hidden TTY prompt — raw-mode byte loop so the terminal does not echo.
 *  Supports backspace; Ctrl-C / Ctrl-D abort. */
function promptHidden(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
      reject(
        new Error(
          "no TTY available for a hidden prompt — pipe the credential on stdin " +
            "or use --credential-file / --credential-env",
        ),
      )
      return
    }
    let secret = ""
    let settled = false
    const done = (err: Error | null) => {
      if (settled) return
      settled = true
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener("data", onData)
      stdin.removeListener("error", onError)
      process.stdout.write("\n")
      if (err) reject(err)
      else resolve(secret)
    }
    const onData = (ch: Buffer) => {
      const s = ch.toString("utf8")
      if (s === "\r" || s === "\n") done(null)
      else if (s === "\u0003" || s === "\u0004") done(new Error("cancelled"))
      else if (s === "\u007f" || s === "\b") secret = secret.slice(0, -1)
      else secret += s
    }
    const onError = (err: Error) => done(err)
    process.stdout.write(promptText)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on("data", onData)
    stdin.on("error", onError)
  })
}

/** Resolve the credential for `create` from exactly one source — a piped
 *  stdin (default), --credential-file <path>, or --credential-env <VAR_NAME>.
 *  The flags take a PATH or a VARIABLE NAME, never the secret value: anything
 *  on the command line lands in shell history and `ps`. Returns undefined
 *  (after writing a usage error to stderr) when the caller should stop. */
async function readCreateCredential(
  values: {
    "credential-file"?: string
    "credential-env"?: string
  },
): Promise<string | undefined> {
  const file = values["credential-file"]
  const envName = values["credential-env"]
  if (file && envName) {
    process.stderr.write(
      `agentproto auth profile create: give ONE of --credential-file / --credential-env (or pipe the credential on stdin)\n`,
    )
    return undefined
  }
  if (file) {
    try {
      const text = (await readFile(file, "utf8")).trim()
      if (!text) {
        process.stderr.write(
          `agentproto auth profile create: --credential-file "${file}" is empty\n`,
        )
        return undefined
      }
      return text
    } catch (err) {
      process.stderr.write(
        `agentproto auth profile create: could not read --credential-file "${file}": ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      )
      return undefined
    }
  }
  if (envName) {
    const value = process.env[envName]?.trim()
    if (!value) {
      process.stderr.write(
        `agentproto auth profile create: --credential-env "${envName}" is unset or empty in this shell\n`,
      )
      return undefined
    }
    return value
  }
  const piped = (await readSecretFromStdin("paste the credential")).trim()
  if (!piped) {
    process.stderr.write(
      `agentproto auth profile create: no credential on stdin — pipe it in, or use --credential-file / --credential-env\n`,
    )
    return undefined
  }
  return piped
}

const CREATE_USAGE_LINE =
  `agentproto auth profile create: usage: create <id> <endpoint> ` +
  `--method <oauth-bearer|api-key> [--label <text>] [--source <name>] ` +
  `[--credential-file <path>] [--credential-env <VAR>] [--credential-ref <slot>] [--json]\n`

async function runProfileCreate(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: {
      method: { type: "string" },
      label: { type: "string" },
      source: { type: "string" },
      "credential-file": { type: "string" },
      "credential-env": { type: "string" },
      "credential-ref": { type: "string" },
      json: { type: "boolean" },
    },
  })
  const [id, endpoint] = positionals
  // Exactly two positionals. A third one is almost always someone pasting the
  // secret as an argument (the `auth cred set` anti-pattern) — refuse it
  // loudly rather than silently ignoring it.
  if (!id || !endpoint || positionals.length > 2) {
    process.stderr.write(CREATE_USAGE_LINE)
    if (positionals.length > 2) {
      process.stderr.write(
        `  (the credential must NEVER be a command-line argument — it lands in ` +
          `shell history and ps output. Pipe it on stdin or use ` +
          `--credential-file / --credential-env.)\n`,
      )
    }
    return 2
  }
  const method = values.method
  if (method !== "oauth-bearer" && method !== "api-key") {
    process.stderr.write(
      `agentproto auth profile create: --method must be "oauth-bearer" or "api-key"${method ? ` (got "${method}")` : " (none given)"}\n\n${CREATE_USAGE_LINE}`,
    )
    return 2
  }

  let credential: string | undefined
  let source: string | undefined
  if (values.source) {
    if (method !== "oauth-bearer") {
      process.stderr.write(
        `agentproto auth profile create: --source is only supported for --method oauth-bearer\n`,
      )
      return 2
    }
    source = values.source
  } else {
    credential = await readCreateCredential(values)
    if (credential === undefined) return 2
  }

  try {
    const created = await createAuthProfile(
      {
        id,
        endpoint,
        method,
        ...(credential !== undefined ? { credential } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(values.label ? { label: values.label } : {}),
        ...(values["credential-ref"]
          ? { credentialRef: values["credential-ref"] }
          : {}),
      },
      localProfileProvisionDeps(),
    )
    if (values.json) {
      process.stdout.write(JSON.stringify({ profile: created }, null, 2) + "\n")
      return 0
    }
    process.stdout.write(
      `agentproto auth: ✓ created auth profile "${created.id}" (${created.endpoint}, ${created.method})\n` +
        (created.source
          ? `  source-backed — no stored secret; credential re-resolved from "${created.source}" at every spawn\n`
          : `  credential → OS keychain (${created.credentialRef})\n` +
            `  fingerprint ${created.fingerprint} (one-way — confirms which secret landed)\n`) +
        `  bill spawns through it: agentproto sessions start <adapter> --access-profile ${created.id}\n`,
    )
    return 0
  } catch (err) {
    if (err instanceof AuthProfileValidationError) {
      process.stderr.write(`agentproto auth profile create: ${err.message}\n`)
      return 2
    }
    throw err
  }
}

async function runProfileList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: { json: { type: "boolean" }, endpoint: { type: "string" } },
  })
  const profiles = await listAuthProfiles(values.endpoint)
  // Mirror auth_profile_list's server-side key-identity enrichment: read the
  // stored secret ONLY to fingerprint it — never emitted (see
  // credentialIdentity's fail-closed last4 rule).
  const store: CredentialStore = new KeychainStore()
  const rows = await Promise.all(
    profiles.map(async (p: AuthProfile) => {
      if (p.credentialRef === undefined) {
        return { ...p, keyStatus: "self-refreshing" as const }
      }
      try {
        const stored = await store.read({ path: p.credentialRef })
        if (!stored || stored.value === "") {
          return { ...p, keyStatus: "unavailable" as const }
        }
        const identity = credentialIdentity(stored.value)
        return {
          ...p,
          keyStatus: "stored" as const,
          fingerprint: identity.fingerprint,
          ...(identity.last4 !== undefined ? { last4: identity.last4 } : {}),
        }
      } catch {
        return { ...p, keyStatus: "unavailable" as const }
      }
    }),
  )
  if (values.json) {
    process.stdout.write(JSON.stringify({ profiles: rows }, null, 2) + "\n")
    return 0
  }
  if (rows.length === 0) {
    process.stdout.write(
      `agentproto auth profile: no profiles. Create one:\n` +
        `  op paste | agentproto auth profile create <id> <endpoint> --method api-key\n` +
        `  agentproto auth discover   — see what's importable on this host\n`,
    )
    return 0
  }
  process.stdout.write(`Auth profiles (${authProfilesPath()}):\n`)
  for (const p of rows) {
    const flag = p.disabled ? "✗ disabled" : "✓"
    const key = (() => {
      if (p.keyStatus === "self-refreshing") return `self-refreshing (source: ${p.source})`
      if (p.keyStatus === "unavailable") return `key UNAVAILABLE at ${p.credentialRef}`
      return `key ${p.fingerprint}${p.last4 ? ` …${p.last4}` : ""} @ ${p.credentialRef}`
    })()
    const models = p.models
      ? p.models.mode === "all"
        ? "models: all"
        : `models: allow[${p.models.ids.length}]`
      : null
    process.stdout.write(
      `  ${flag}  ${p.id}  ${p.endpoint}  ${p.method}` +
        (p.label ? `  "${p.label}"` : "") +
        `  ${key}\n` +
        (models ? `       ${models}\n` : ""),
    )
  }
  return 0
}

async function runProfileRm(args: readonly string[]): Promise<number> {
  const id = args[0]
  if (!id) {
    process.stderr.write(`agentproto auth profile rm: usage: rm <id>\n`)
    return 2
  }
  try {
    const result = await deleteAuthProfile(id, localProfileProvisionDeps())
    process.stdout.write(
      result.deleted
        ? `agentproto auth: ✓ removed auth profile "${result.id}"${
            result.credentialRef ? ` (keychain slot ${result.credentialRef} cleared when no other profile references it)` : " (source-backed — no stored secret to clear)"
          }\n`
        : `agentproto auth: no auth profile with id "${id}"\n`,
    )
    return 0
  } catch (err) {
    if (err instanceof AuthProfileValidationError) {
      process.stderr.write(`agentproto auth profile rm: ${err.message}\n`)
      return 2
    }
    throw err
  }
}

async function runProfileImport(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: { id: { type: "string" }, label: { type: "string" }, json: { type: "boolean" } },
  })
  const [origin, endpoint] = positionals
  if (!origin || !endpoint || positionals.length > 2) {
    process.stderr.write(
      `agentproto auth profile import: usage: import <origin> <endpoint> [--id <id>] [--label <text>]\n` +
        `  origins: ${IMPORT_ORIGINS.join(", ")} (run \`agentproto auth discover\` to see what's present)\n`,
    )
    return 2
  }
  if (!IMPORT_ORIGINS.includes(origin)) {
    process.stderr.write(
      `agentproto auth profile import: unknown origin "${origin}" — must be one of ${IMPORT_ORIGINS.join(", ")}\n`,
    )
    return 2
  }
  try {
    const created = await importDiscoveredCredential(
      {
        origin,
        endpoint,
        ...(values.id ? { id: values.id } : {}),
        ...(values.label ? { label: values.label } : {}),
      },
      localProfileProvisionDeps(),
    )
    if (values.json) {
      process.stdout.write(JSON.stringify({ profile: created }, null, 2) + "\n")
      return 0
    }
    process.stdout.write(
      `agentproto auth: ✓ imported "${created.id}" (${created.endpoint}, ${created.method}, origin ${created.origin})\n` +
        (created.fingerprint
          ? `  credential fingerprint ${created.fingerprint}\n`
          : `  source-backed — no stored secret\n`) +
        `  bill spawns through it: agentproto sessions start <adapter> --access-profile ${created.id}\n`,
    )
    return 0
  } catch (err) {
    if (err instanceof CredentialImportError || err instanceof AuthProfileValidationError) {
      process.stderr.write(`agentproto auth profile import: ${err.message}\n`)
      return 2
    }
    throw err
  }
}

async function runProfileSetModels(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: { json: { type: "boolean" } },
  })
  const [id, mode, ...idsRaw] = positionals
  if (!id || !mode) {
    process.stderr.write(
      `agentproto auth profile set-models: usage: set-models <id> <all|allow> [<ids…>]\n` +
        `  ids are space- or comma-separated model identities (catalog vendor/product\n` +
        `  or route-qualified ref). "all" clears the allowlist.\n`,
    )
    return 2
  }
  if (mode !== "all" && mode !== "allow") {
    process.stderr.write(
      `agentproto auth profile set-models: mode must be "all" or "allow" (got "${mode}")\n`,
    )
    return 2
  }
  const ids = idsRaw.flatMap(s => s.split(",")).map(s => s.trim()).filter(Boolean)
  if (mode === "allow" && ids.length === 0) {
    process.stderr.write(
      `agentproto auth profile set-models: mode "allow" needs at least one model id\n`,
    )
    return 2
  }
  try {
    const profile = await setAuthProfileModels(
      id,
      { mode, ids: mode === "all" ? [] : ids },
      localProfileProvisionDeps(),
    )
    if (values.json) {
      process.stdout.write(JSON.stringify({ profile }, null, 2) + "\n")
      return 0
    }
    const curated = profile.models
    process.stdout.write(
      `agentproto auth: ✓ set models for "${profile.id}"\n` +
        `  ${
          curated
            ? `allow (${curated.ids.length} id${curated.ids.length === 1 ? "" : "s"})`
            : "all — every eligible model, allowlist cleared"
        }\n`,
    )
    return 0
  } catch (err) {
    if (err instanceof AuthProfileValidationError) {
      process.stderr.write(`agentproto auth profile set-models: ${err.message}\n`)
      return 2
    }
    throw err
  }
}

async function runProfileSetEnabled(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: { json: { type: "boolean" } },
  })
  const [id, state] = positionals
  const enabled =
    state === "true" || state === "enable" || state === "enabled"
      ? true
      : state === "false" || state === "disable" || state === "disabled"
        ? false
        : undefined
  if (!id || enabled === undefined) {
    process.stderr.write(
      `agentproto auth profile set-enabled: usage: set-enabled <id> <true|false>\n` +
        `  (also accepts enable/disable/enabled/disabled)\n`,
    )
    return 2
  }
  try {
    const profile = await setAuthProfileEnabled(id, enabled, localProfileProvisionDeps())
    if (values.json) {
      process.stdout.write(JSON.stringify({ profile }, null, 2) + "\n")
      return 0
    }
    process.stdout.write(
      `agentproto auth: ✓ ${enabled ? "enabled" : "DISABLED"} auth profile "${profile.id}"${
        enabled ? "" : " — every model it would bill is now non-runnable"
      }\n`,
    )
    return 0
  } catch (err) {
    if (err instanceof AuthProfileValidationError) {
      process.stderr.write(`agentproto auth profile set-enabled: ${err.message}\n`)
      return 2
    }
    throw err
  }
}

// ── discover local credentials ─────────────────────────────────────────

const DISCOVER_USAGE = `agentproto auth discover — scan this host for importable credentials

Probes the well-known local locations where the CLIs and gateways you already
use write their credentials (Claude Code's OAuth item, Codex/Gemini login
files, ~/.hermes/config.yaml, provider API-key env vars) and reports what it
FINDS — so you can import what you have instead of pasting it again.

Read-only, and never prints a secret value — each hit is a provenance + a
non-secret locator (WHERE the credential is, never WHAT it is).

Usage:
  agentproto auth discover [--endpoint <e>] [--json]

Import a hit into a named profile:
  agentproto auth profile import <origin> <endpoint> [--id <id>] [--label <text>]
`

/** Test seam: override the discovery scanner (a real scan probes the live
 *  home dir / env, which a unit test must not do). `undefined` restores the
 *  real scanner from `@agentproto/runtime/credential-discovery`. */
let discoverCredentialsImpl = discoverCredentials
export function setDiscoverCredentialsForTests(
  impl: typeof discoverCredentials | undefined,
): void {
  discoverCredentialsImpl = impl ?? discoverCredentials
}

async function runAuthDiscover(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: { json: { type: "boolean" }, endpoint: { type: "string" } },
  })
  let found: DiscoveredCredential[]
  try {
    found = discoverCredentialsImpl({
      warn: msg =>
        process.stderr.write(`agentproto auth discover: ⚠ ${msg}\n`),
    })
  } catch (err) {
    process.stderr.write(
      `agentproto auth discover: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
  if (values.endpoint) {
    found = found.filter(c => c.endpoint === values.endpoint)
  }
  if (values.json) {
    process.stdout.write(JSON.stringify({ credentials: found }, null, 2) + "\n")
    return 0
  }
  if (found.length === 0) {
    process.stdout.write(
      `agentproto auth discover: no local credentials found.\n` +
        `  Create one from scratch: op paste | agentproto auth profile create <id> <endpoint> --method api-key\n`,
    )
    return 0
  }
  process.stdout.write(`Discovered credentials on this host:\n`)
  for (const c of found) {
    process.stdout.write(
      `  ✓ ${c.endpoint}  ${c.method}  from ${c.origin}\n` +
        `     ${c.hint}\n` +
        `     import: agentproto auth profile import ${c.origin} ${c.endpoint}\n`,
    )
  }
  return 0
}

async function runProfileRefreshModels(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: { json: { type: "boolean" } },
  })
  const [id] = positionals
  if (!id) {
    process.stderr.write(
      `agentproto auth profile refresh-models: usage: refresh-models <id> [--json]\n`,
    )
    return 2
  }

  const deps = localProfileProvisionDeps()
  // Not just a defensive fast-fail: we need `profile.endpoint` to build the
  // current-catalog snapshot below, so this fetch+check is unavoidable here
  // regardless of the below call. `refreshAuthProfileModels` re-checks
  // existence itself (an extra, cheap local-file read) because it must stay
  // safe to call directly (e.g. from the MCP tool) without a caller having
  // pre-fetched the profile first — deliberate double-validation, not an
  // oversight.
  const profile = await deps.getProfile(id)
  if (!profile) {
    process.stderr.write(`agentproto auth profile refresh-models: no profile with id "${id}"\n`)
    return 1
  }

  const currentIds = getModelsByProvider(profile.endpoint).map(m => m.id)

  try {
    const result = await refreshAuthProfileModels(id, currentIds, deps)
    if (values.json) {
      process.stdout.write(
        JSON.stringify(
          { profile: result.profile, added: result.added, removed: result.removed },
          null,
          2,
        ) + "\n",
      )
      return 0
    }
    const count = result.profile.models?.ids.length ?? 0
    const deltas = [
      result.added.length ? `+${result.added.length} added` : null,
      result.removed.length ? `-${result.removed.length} removed` : null,
    ].filter(Boolean)
    process.stdout.write(
      `agentproto auth: ✓ refreshed "${id}" against the current ${profile.endpoint} catalog\n` +
        `  ${count} model id${count === 1 ? "" : "s"} now allowed` +
        (deltas.length ? ` (${deltas.join(", ")})\n` : " (no change)\n"),
    )
    return 0
  } catch (err) {
    if (err instanceof AuthProfileValidationError) {
      process.stderr.write(`agentproto auth profile refresh-models: ${err.message}\n`)
      return 2
    }
    throw err
  }
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
