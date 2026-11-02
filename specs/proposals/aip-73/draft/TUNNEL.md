# AIP-73: Tunnel Provider

- **Status:** Draft proposal (not yet vendored)
- **Type:** Primitive / provider contract
- **Reference implementation:** `@agentproto/tunnel`, `@agentproto/tunnel-agentik`

> This draft lives under `specs/proposals/` because `specs/resources/` is a
> vendored, sync-only mirror of `agentproto/agentproto` and CI rejects files
> authored there. Before this can be a canonical AIP it must be merged into
> `agentproto/agentproto/specs/` and then synced into `specs/resources/`.

## Abstract

A **Tunnel Provider** exposes a stable public URL for a locally running
service. This AIP defines the provider contract, the authentication modes,
the on-disk credential store, provider discovery, and the lifecycle every
implementation follows. A provider is intentionally small: it owns *remote
tunnel state* and the connector that publishes a local target, and nothing
about sessions, apps, or routing.

## Motivation

agentproto currently ships several tunnel backends inline in the runtime
(quick Cloudflare tunnels, named Cloudflare tunnels, a remote Cloudflare
provisioner, ngrok). Third parties cannot add a backend without patching the
runtime. Extracting the contract into a public primitive gives every backend
the same shape, lets daemons list/capability-query them uniformly, and makes
a provider implementable in a package with no dependency on the runtime.

## Terminology

| Term | Meaning |
| --- | --- |
| **Provider** | An implementation of the `TunnelProvider` interface, identified by a stable `slug`. |
| **Key** | A caller-chosen, stable tunnel identity. It survives restarts and namespaces remote state. |
| **Target** | The local `host:port` (and optional protocol) the tunnel forwards to. |
| **Connector** | The process or sidecar that maintains the tunnel (e.g. `cloudflared`). |
| **Hostname** | A public DNS name routed to the tunnel, primary first. |
| **Connector token** | A short-lived secret the provider returns so the caller can start the connector. Never logged. |

## Provider interface

```ts
interface TunnelProvider {
  readonly slug: string
  readonly name: string
  readonly capabilities: TunnelCapabilities

  create(input: CreateTunnelInput): Promise<TunnelInfo>
  list(): Promise<TunnelInfo[]>
  delete(key: string): Promise<void>
  status(key: string): Promise<TunnelInfo | null>
  health(): Promise<TunnelHealth>
}

interface CreateTunnelInput {
  key: string
  service?: string | null          // "http://127.0.0.1:3000", or null to keep origin
  hostnames?: string[]             // request, primary first; empty = assign one
  target?: TunnelTarget            // convenience; providers may derive service
  metadata?: Record<string, string>
}

interface TunnelInfo {
  key: string
  tunnelId?: string
  status: "active" | "starting" | "stopped" | "error" | "unknown"
  publicUrl?: string
  hostnames: string[]
  service?: string | null
  createdAt?: string
  updatedAt?: string
  connectorToken?: string          // sensitive
}

interface TunnelHealth {
  state: "active" | "degraded" | "error" | "unknown"
  reason?: string
  checkedAt: string                // ISO-8601
  latencyMs?: number
  hostnames?: Array<{ hostname: string; ok: boolean; reason?: string }>
}

interface TunnelCapabilities {
  stableUrl: boolean
  autostart: boolean
  customDomain: boolean
  requiresAuth: boolean
  hasApi: boolean
}
```

Rules:

- `create` is **idempotent** on `key`: re-creating an existing tunnel updates
  it and returns the current state.
- `delete` is **idempotent**: deleting an unknown key is not an error.
- `status` returns `null` for an unknown key; transport/auth failures throw.
- `health` reports a *state*, not an error: unreachable providers return
  `{ state: "error" }` rather than throwing.
- A provider never logs credentials, connector tokens, or full request
  bodies.

## Authentication modes

A provider declares exactly one auth mode per configured instance:

| Mode | Shape | Transport | Use |
| --- | --- | --- | --- |
| `apiKey` | `{ mode: "apiKey", apiKey }` | `Authorization: Bearer <apiKey>` | Server-issued long-lived keys (e.g. `sk-…`). |
| `token` | `{ mode: "token", token, expiresAt? }` | `Authorization: Bearer <token>` | A caller-supplied short-lived token. |
| `oidc` | `{ mode: "oidc", issuer, clientId, scopes?, accessToken(), logout?() }` | `Authorization: Bearer <accessToken()>` | RFC 8628 device login; the provider refreshes and retries once on `401`. |

An implementation that supports more than one mode documents which one wins
when several are configured. apiKey SHOULD take precedence over OIDC.

## Credential store

Provider configuration is stored **outside the repo**, one file per slug:

```
~/.agentproto/tunnel-creds/<slug>.json
```

- Directory mode `0700`, file mode `0600`.
- The file is a flat JSON object of setup fields (`baseUrl`, `apiKey`,
  `oidcIssuer`, `oidcClientId`, `oidcScopes`, …).
- `apiKey`, `token`, and any connector token are secrets: never echo them in
  logs, errors, CLI output, or HTTP responses.
- A provider may additionally keep refreshed OIDC sessions under
  `~/.agentproto/tunnel-sessions/<slug>.json`; the long-lived API key does
  not belong there.
- `AGENTPROTO_HOME` overrides the `~/.agentproto` root.

## Discovery and registration

- **Slug:** lowercase, `^[a-z0-9][a-z0-9._-]*$`, unique per host.
- **Package:** first-party providers publish as
  `@agentproto/tunnel-<slug>` and export a provider factory plus, optionally,
  a `fromTunnelCredentials(record)` helper.
- **Declared metadata:** `slug`, `name`, `capabilities`, and a setup-field
  list carrying `name`, `description`, `required`, and `sensitive`.
- **Registration:** the daemon discovers installed `@agentproto/tunnel-*`
  packages and validates their declared setup fields before persisting
  credentials. A provider whose declared fields are invalid is not
  registered.

Built-in slugs in the reference runtime are `cloudflare-quick`,
`cloudflare-named`, `cloudflare-provisioned`, and `ngrok`; the reference
extraction adds `agentik`.

## Lifecycle

```
setup ──▶ auth ──▶ create ──▶ start connector ──▶ health ──▶ stop ──▶ delete
```

1. **setup** - collect setup fields, validate URLs/slugs, persist to
   `~/.agentproto/tunnel-creds/<slug>.json` (`0700`/`0600`).
2. **auth** - resolve a bearer credential. OIDC may require an interactive
   device flow first; `state()` reports `pending`/`logged_in`/`logged_out`.
3. **create** - `PUT` the tunnel identity and desired hostnames; obtain the
   routed hostnames and a connector token.
4. **start connector** - spawn/supervise the provider's connector with the
   token in the environment only (never argv).
5. **health** - probe the public URL or the provider API; surface
   `active` / `degraded` / `error` plus per-hostname results.
6. **stop** - terminate the connector. Idempotent.
7. **delete** - remove remote state. Idempotent; must not stop a connector
   that is still running unless the caller asked.

Starting a tunnel must be abort-safe: if `stop()` lands while `create()` is
in flight, the provider must not leak a connector.

## HTTP contract (provider v1)

Providers that expose a remote API use these three endpoints. All calls
carry `Authorization: Bearer <credential>`.

```
GET    {baseUrl}/v1/tunnels
       200 { tunnels: [TunnelRecord, …] }

PUT    {baseUrl}/v1/tunnels/{key}
       body { service: "http://127.0.0.1:<port>" | null, hostnames: string[] }
       200 { key, tunnelId, hostnames: string[], publicUrl?, token }

DELETE {baseUrl}/v1/tunnels/{key}
       2xx | 404
```

- `key` is URL-encoded; two users' identical keys must not collide on the
  server.
- `hostnames` is a *request*; the server returns what it actually routed.
- `PUT` is idempotent and is replayed on every start.
- Errors are JSON `{ error, message, checkoutUrl? }`.
  - `401` - credential invalid or expired (OIDC: refresh once, then prompt).
  - `402` - payment required; `checkoutUrl` is surfaced to the user.
  - `409` - hostname already taken.

## Security considerations

- HTTPS only, except loopback hosts (`localhost`, `127.0.0.1`, `[::1]`).
- Credential/connector-token material never travels in argv or logs.
- Credential files are `0600`; their directory is `0700`.
- Connector tokens are short-lived and scoped to one tunnel.
- A provider must not trust `hostnames`/`service` values from untrusted
  input without server-side validation.

## Conformance

An implementation is conformant when:

1. It implements every method of `TunnelProvider`.
2. `create` and `delete` are idempotent, and `status` is `null` for unknown
   keys.
3. `health` returns a state instead of throwing on transport failure.
4. Credentials are stored per the credential-store section with `0700`/`0600`.
5. No secret appears in error messages, logs, or `TunnelInfo` beyond the
   explicitly-declared `connectorToken` field.
