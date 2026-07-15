# Credentials

Two unrelated credential stores live under `~/.agentproto/`, covering two
different problems:

1. **Host bearer tokens** (`credentials.json`) — this daemon authenticating
   *to its tunnel host* (`agentproto auth login`). Covered below.
2. **Broker credentials** (`auth-providers.json` + OS keychain) — secrets a
   *spawned agent's* MCP servers need, resolved at spawn time via
   `credentialRef`. See "Broker credentials" further down and
   [`verbs/auth.md`](../verbs/auth.md#cred--broker-credentials-for-child-mcp-auth-050).

## Host bearer tokens

The CLI stores host bearer tokens in `~/.agentproto/credentials.json`,
mode `0600`, one file per OS user with many hosts inside. Tokens come
from `agentproto auth login` (RFC 8628 device flow) — see
[`verbs/auth.md`](../verbs/auth.md) for the flow itself.

## Where

- Path: `$AGENTPROTO_HOME/credentials.json` (defaults to
  `~/.agentproto/credentials.json`).
- File mode: `0600` enforced on every write. Skipped on Windows
  (per-user profile directory is already private).
- Never logged. The CLI scrubs token values from any output it
  produces.

## Format

```jsonc
{
  "version": 1,
  "hosts": {
    "wss://guilde.work/api/v1/agentproto/tunnel": {
      "token": "eyJ…",
      "tokenType": "Bearer",
      "expiresAt": "2026-08-08T12:34:56.000Z",
      "refreshToken": "rt_…",
      "scope": "tunnel:connect",
      "subject": "user_abc",
      "obtainedAt": "2026-05-10T08:21:11.000Z",
      "deviceLabel": "jeremy@laptop",
      "revocationId": "jti_…"
    }
  }
}
```

Full per-field schema in
[`reference/credentials-format.md`](../reference/credentials-format.md).

## Per-host keying

Hosts are keyed by the URL you passed to `agentproto auth login
--host <url>`, trailing slash stripped. The same key powers:

- `agentproto serve --connect <url>` — looks up the token when
  `--token` isn't supplied.
- Plugin code reading credentials via
  `@agentproto/cli/util/credentials` — same lookup semantics, so a
  plugin that talks to its vendor's MCP can reuse the cli's auth
  store.

The host URL is matched verbatim against the file's keys. If you
logged in to `https://example.com` but a plugin probes
`https://example.com/api/v1`, the plugin must walk back to the host
root (or expose a `--host` flag) — there's no path-stripping done
automatically.

## Reading from plugin code

```ts
import {
  loadCredentials,
  normaliseHost,
  isExpired,
} from "@agentproto/cli/util/credentials"

const all = await loadCredentials()
const cred = all.hosts[normaliseHost("https://example.com")]
if (cred && !isExpired(cred)) {
  // use cred.token
}
```

This is the supported way for plugins to share the auth store. Don't
read `~/.agentproto/credentials.json` directly — the format may evolve
across major versions and the helpers track it.

## Refresh

Some hosts issue a `refreshToken` alongside the access token. `agentproto
serve --connect <host>` attempts a silent non-interactive refresh when
reconnecting with an expired credential that has a stored `refreshToken`.
Run `agentproto auth login --host <url>` only when silent refresh fails
or no refresh token exists.

## Logout

```bash
agentproto auth logout --host <url>
```

Removes the host from the file. If the host exposed a `revocationId`,
the CLI sends it back so the server-side row gets revoked, not just
the local copy.

## Broker credentials

Separate from everything above: `agentproto auth cred set|list|rm` manages
credentials for MCP servers a *spawned agent* mounts, not this daemon's own
host auth. The secret itself goes to the OS keychain; only the non-secret
provider definition (`apiBase`, `audience`, `description`) is persisted to
`~/.agentproto/auth-providers.json`. A session's
`mcpServers[].credentialRef` (`"<id>"` or `"<id>/<account>"`) resolves
through the daemon's `CredentialBroker` at spawn time, and the resulting
header is merged on top of any static `headers` already on that entry.
Full command reference:
[`verbs/auth.md#cred`](../verbs/auth.md#cred--broker-credentials-for-child-mcp-auth-050).
