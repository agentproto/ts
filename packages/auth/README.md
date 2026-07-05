# @agentproto/auth

AIP-50 `AUTH.md` reference implementation. An auth-provider doctype: a markdown +
frontmatter (or TS-literal) manifest that declares, for one API server, **how** a
CLI tool or agent authenticates and **where** to call the AIP-19 provision
endpoints. It holds configuration, never credentials — the flow engine reads or
prompts credentials at runtime.

Aligned to the WorkOS [auth.md](https://github.com/workos/auth.md) open standard:
two-hop `.well-known` discovery, the `agent_auth` metadata block, and the
service-auth claim ceremony (`urn:workos:agent-auth:grant-type:claim`).

> **Status: 0.1.0-alpha.** Two flows specified in v1 (`pat`, `service-auth`);
> `id-jag` (agentproto-as-IdP) is reserved.

Spec: <https://agentproto.sh/docs/aip-50> · Standard: <https://github.com/workos/auth.md>

## Install

```bash
pnpm add @agentproto/auth
```

## Two authoring paths, one validated shape

A single Zod schema (`./schema.ts`) backs both paths, so a malformed literal and
a malformed `.md` fail with the same diagnostic.

### TS literal

```ts
import { defineAuthProvider } from "@agentproto/auth"

export const guilde = defineAuthProvider({
  id: "guilde",
  description: "Guilde AI company platform — browser-approve, no key to paste.",
  apiBase: "https://api.guilde.work",
  auth: {
    flow: "service-auth",
    clientId: "agentproto-cli",
    tokenStore: { keychain: "bureau-guilde", account: "{server}" },
  },
  install: {
    sealKey: "/guilde/api/v1/connectors/seal-key",
    secretBacked: "/guilde/api/v1/guilds/{guildId}/connectors/secret-backed",
  },
})
```

### `.md` manifest

A host reads its own vendor-shipped `*.auth.md` and registers it without editing
this package — the manifest parser is the extension seam.

```md
---
id: acme
description: ACME API — paste a personal access token.
apiBase: https://api.acme.example
auth:
  flow: pat
  tokenStore:
    keychain: acme-cli
    account: "{server}"
---

# ACME

Human/LLM-facing prose about how to obtain a token lives in the body.
```

```ts
import { parseAuthProviderManifest, registerAuthProvider } from "@agentproto/auth"

const acme = parseAuthProviderManifest(await readFile("acme.auth.md", "utf8"))
registerAuthProvider(acme)
```

## Running a flow

`runAuthFlow` resolves the provider, attempts discovery, and dispatches to the
engine selected by `provider.auth.flow` — no `if`/`switch` chains at call sites.

```ts
import { getAuthProvider, runAuthFlow } from "@agentproto/auth"

const provider = getAuthProvider("guilde")!
const result = await runAuthFlow(provider, { server: "https://api.guilde.work" })
// → { accessToken: "oat_…", tokenKind: "oat" }
```

### `pat` flow

Read an existing token from the platform Keychain, or prompt for one
interactively. No browser, no ceremony — the legacy-compatible path for servers
that issue personal access keys.

### `service-auth` flow

The auth.md claim ceremony:

1. `POST {identity_endpoint}` with `{ type: "service_auth", client_id }` →
   `claim_token` + `claim.{ user_code, verification_uri, expires_in }`.
2. Open the browser at `verification_uri`; the user approves.
3. Poll `POST {token_endpoint}` with
   `grant_type=urn:workos:agent-auth:grant-type:claim` and `claim_token` until
   `access_token` is returned (`authorization_pending` / `slow_down` /
   `expired_token` / `access_denied` are handled per RFC 8628).
4. On success, store the **`identity_assertion` JWT** in the Keychain — per
   AIP-50, the assertion is the durable credential; the `access_token` is
   ephemeral and is **never persisted**, and the `claim_token` stays in memory
   only.

On a subsequent run the ceremony is skipped when possible: the stored assertion
is exchanged at the token endpoint via
`urn:ietf:params:oauth:grant-type:jwt-bearer` for a fresh `access_token` ("this
IS the refresh path" — no refresh token). Only when the assertion is expired or
rejected (`invalid_grant`) does a new browser ceremony start.

## Discovery

`discoverEndpoints(apiBase)` performs the two-hop chain and **throws
`DiscoveryError`** when a server predates auth.md. Callers catch it and fall back
to the static manifest config — discovery failure must never block a static flow.

```
GET {apiBase}/.well-known/oauth-protected-resource     → authorization_servers[0]
GET {authServerBase}/.well-known/oauth-authorization-server
                                  → token_endpoint + agent_auth.identity_endpoint
```

Every request (discovery, ceremony, refresh) is bounded by a per-request
timeout (`DEFAULT_HTTP_TIMEOUT_MS`, override via `discoverEndpoints(base,
{ timeoutMs })`) and honours a caller `AbortSignal` (`{ signal }` /
`FlowRunOptions.signal`), so a hung server can never stall the CLI. Responses
are Zod-validated at the boundary rather than trusted.

## Token storage

`token-store.ts` wraps the macOS `security` CLI and **guards the platform** —
`readKeychainToken` / `writeKeychainToken` throw a clear error on non-macOS hosts
rather than silently returning `undefined` (which would re-prompt every run).
Swap this module for libsecret (Linux) / Credential Manager (Windows) to run
elsewhere. `resolveAccount(account, server)` expands the `{server}` template in a
`tokenStore.account` spec.

## Credential store

Flow engines never touch a concrete backend — they depend on the
`CredentialStore` interface, so the same `pat` / `service-auth` flow runs
against the macOS Keychain in a CLI, an in-memory map in a test, or an
encrypted file on a headless host.

```ts
interface CredentialStore {
  read(ref: StoreRef): Promise<StoredCredential | undefined>
  write(ref: StoreRef, cred: StoredCredential): Promise<void>
  delete?(ref: StoreRef): Promise<void>   // optional — backend permitting
}

interface StoreRef { path: string; account?: string }      // where it lives
interface StoredCredential {                               // what's stored
  value: string
  kind: "pat" | "assertion" | "oat"
  expiresAt?: string
  metadata?: Record<string, unknown>
}
```

`resolveStoreRef(tokenStore, server)` maps a provider's `tokenStore` spec
(expanding the `{server}` template) to a `StoreRef` — so a token **written**
under a ref resolves under the **same** ref on read.

| Backend | Use |
| --- | --- |
| `KeychainStore` | macOS `security` CLI — the interactive-CLI default |
| `MemoryStore` | ephemeral, for tests |
| `FileStore` | AES-256-GCM at rest; key from `AGENTPROTO_STORE_KEY`, **no plaintext fallback** — for headless hosts with no Keychain |

A host can implement the interface over its own vault (Guilde backs it with an
AAD-bound, per-user secrets service). The flow engine is none the wiser.

## Credential broker — `resolveHeaders`

The broker is the "Agent.pw parity" surface: give it a **path**, get back
ready-to-use HTTP auth headers, with a *fresh* token resolved at call-time. It
turns a stored credential (or a full flow run) into
`{ Authorization: "Bearer …" }` without the caller knowing which.

```ts
import { CredentialBroker } from "@agentproto/auth"

const broker = new CredentialBroker({ store, getProvider: getAuthProvider })

const headers = await broker.resolveHeaders({
  path: "guilde",              // "<providerId>" or "<providerId>/<account>"
  server: "https://api.guilde.work", // optional; defaults to provider.apiBase
  signal,                      // optional AbortSignal
})
// → { Authorization: "Bearer oat_…" }
```

`resolveHeaders`:

1. parses `path` → `providerId` (+ optional `account`) and resolves the
   provider via `getProvider`; **throws** on an unknown provider;
2. reads the store at the resolved ref — if a stored bearer credential is
   still **fresh** (past a 60s skew), returns it directly;
3. otherwise runs the provider's flow (`runAuthFlow`, threading the same
   `store` + `signal`) — for `service-auth`, that's the assertion →
   `jwt-bearer` exchange — and returns the minted token;
4. throws if the flow yields no usable access token.

**Fresh-per-call, no long-lived header cache.** This is the headless/cron
payoff: a scheduled agent re-resolves a valid `Authorization` at connect-time
with no human re-auth, as long as a durable credential (a PAT, or a
`service-auth` assertion) sits in the store.

> **Runnable example:** `src/__tests__/broker.example.test.ts` is a
> zero-mock, copy-pasteable wire-up (provider → store → broker →
> `resolveHeaders`) you can lift verbatim.

### Feeding an MCP transport

`@agentproto/secrets/exposure` declares a **structural** `McpHeaderResolver`
(`resolveHeaders({ path, server?, signal? })`) that `CredentialBroker`
satisfies with no adapter — so a connector can declare an `mcp-header`
exposure and have `resolveMcpHeaderExposure(exposure, broker)` lay brokered
headers onto the transport. `secrets` keeps **zero dependency** on `auth`
through that structural seam. See `@agentproto/secrets`' README.

## API surface

| Export | Purpose |
| --- | --- |
| `defineAuthProvider(def)` | TS-literal authoring → frozen handle |
| `parseAuthProviderManifest(src)` | `.md` authoring → frozen handle |
| `registerAuthProvider` / `getAuthProvider` / `listAuthProviders` / `listAuthProviderIds` | module-level registry (pre-seeded with builtins) |
| `discoverEndpoints` / `DiscoveryError` | two-hop `.well-known` discovery |
| `runAuthFlow` | resolve → discover → dispatch |
| `FLOW_ENGINES` | registered flow engines (`pat`, `service-auth`) |
| `CredentialBroker` / `CredentialBrokerOptions` | path → fresh `resolveHeaders` |
| `CredentialStore` / `StoreRef` / `StoredCredential` | pluggable-store interface + shapes |
| `KeychainStore` / `MemoryStore` / `FileStore` / `resolveStoreRef` | built-in backends + ref resolver |
| `readKeychainToken` / `writeKeychainToken` / `resolveAccount` | Keychain helpers |
| `guildeAuthProvider` / `BUILTIN_AUTH_PROVIDERS` | shipped builtins |

## License

MIT — see [LICENSE](./LICENSE).
