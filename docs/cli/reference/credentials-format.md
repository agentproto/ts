# Credentials format — `~/.agentproto/credentials.json`

The on-disk shape of the CLI's host-credentials store, as defined in
`@agentproto/cli/util/credentials`. For semantics and the install
flow, see [`concepts/credentials.md`](../concepts/credentials.md).

## File

```jsonc
{
  "version": 1,
  "hosts": {
    "<host-url>": { /* HostCredential — see below */ }
  }
}
```

- `version: 1` — the file-format version. Unrecognised versions cause
  the CLI to refuse the file with a "delete and re-login" error
  rather than parsing potentially-incompatible data.
- `hosts: Record<string, HostCredential>` — keyed by the URL passed to
  `agentproto auth login --host <url>`, trailing slash stripped.

## `HostCredential` shape

```ts
interface HostCredential {
  /** Bearer token. Bearer-form is the only one supported today. */
  token: string

  /** Always "Bearer" today; reserved for future schemes. */
  tokenType: "Bearer"

  /** ISO-8601. May be in the past — callers must check `isExpired`. */
  expiresAt: string

  /** OAuth 2.0 refresh token. Present when the host issues one. */
  refreshToken?: string

  /** Space-separated scopes the token was issued with. */
  scope?: string

  /**
   * Human-readable subject — usually the user id. Surfaced by
   * `agentproto auth status`.
   */
  subject?: string

  /** ISO-8601 of when this credential was minted. */
  obtainedAt: string

  /**
   * Friendly device label shown on the host's "machine tokens" page,
   * if it has one. Sent to the host during the device-flow
   * authorization request.
   */
  deviceLabel?: string

  /**
   * Opaque revocation hint the host surfaced (typically a JTI). The
   * CLI passes it back on `agentproto auth logout` so the host can
   * revoke the right row server-side, not just delete the local copy.
   */
  revocationId?: string
}
```

## Helpers

The exports below are part of the public surface
(`@agentproto/cli/util/credentials`):

```ts
function credentialsPath(): string

function normaliseHost(host: string): string
// Strips trailing slashes. Use before reading hosts[key].

async function loadCredentials(): Promise<CredentialsFile>
// Reads + parses the file. Returns
// { version: 1, hosts: {} } on ENOENT (file absent).

async function saveCredentials(file: CredentialsFile): Promise<void>
// Writes + chmods 0600. Skips chmod on Windows.

async function readHost(host: string): Promise<HostCredential | null>
async function writeHost(host: string, cred: HostCredential): Promise<void>
async function deleteHost(host: string): Promise<HostCredential | null>
// deleteHost unlinks the file when it removes the last host.

function isExpired(cred: HostCredential, gracePeriodMs?: number): boolean
// Default grace period 30s. Returns false for unparseable expiresAt
// (trust the host — don't refuse usable tokens because of a bad ISO).

function formatExpiry(cred: HostCredential): string
// "expires in 2h", "expired 5d ago", or "unknown".
```

## Example

A credentials file after logging into two hosts:

```jsonc
{
  "version": 1,
  "hosts": {
    "https://guilde.work": {
      "token": "eyJhbGciOiJIUzI1NiIs…",
      "tokenType": "Bearer",
      "expiresAt": "2026-08-08T12:34:56.000Z",
      "refreshToken": "rt_v1_abc…",
      "scope": "tunnel:connect operator:run",
      "subject": "user_abc",
      "obtainedAt": "2026-05-10T08:21:11.000Z",
      "deviceLabel": "jeremy@laptop",
      "revocationId": "jti_xyz123"
    },
    "https://my-gateway.internal": {
      "token": "ghs_…",
      "tokenType": "Bearer",
      "expiresAt": "2026-09-01T00:00:00.000Z",
      "obtainedAt": "2026-05-15T17:00:00.000Z"
    }
  }
}
```

## File lifecycle

1. **First login** — file created with `mode 0600`. Parent
   `~/.agentproto/` is `mkdir -p`'d.
2. **Subsequent logins** — host entry replaced or added.
3. **Logout** — host entry removed. When `hosts` becomes empty, the
   file is `unlink`ed (so `agentproto auth status` cleanly reports
   "no credentials").
4. **Manual edit** — supported. The CLI re-reads on every operation
   and tolerates unknown fields (preserved on write).

## Format versioning

The `version` field exists to gate future incompatible changes — if
the CLI bumps to `version: 2`, older binaries refuse the file with
guidance to re-login. This file format is independent of the npm
package version. See [`../../VERSIONING.md`](../../VERSIONING.md) for
the multi-axis version story.

## Broker provider format — `~/.agentproto/auth-providers.json` (0.5.0+)

A separate, unrelated file from `credentials.json` above: definitions for
`agentproto auth cred` broker credentials (see
[`concepts/credentials.md`](../concepts/credentials.md#broker-credentials)
and [`verbs/auth.md#cred`](../verbs/auth.md#cred--broker-credentials-for-child-mcp-auth-050)).
The secret itself never lands in this file — it's written to the OS
keychain; this file only holds the non-secret provider definition, keyed by
the id passed to `agentproto auth cred set <id> ...`.

```ts
interface AuthProviderDefEntry {
  apiBase: string
  audience: string
  flow: "pat"
  description?: string
  tokenStore: { keychain: string; path: string }
  updatedAt: string
}
```

```jsonc
{
  "my-api": {
    "apiBase": "https://api.example.com",
    "audience": "mcp",
    "flow": "pat",
    "description": "Example API for agent MCP servers",
    "tokenStore": { "keychain": "agentproto-broker", "path": "my-api" },
    "updatedAt": "2026-07-08T15:00:00.000Z"
  }
}
```

`agentproto auth cred rm <id>` removes the entry here and attempts a
best-effort keychain delete when the store backend supports it.
