# `agentproto auth`

```text
agentproto auth login   [--host <url>] [--label <name>] [--no-browser] [--scope <s>]
agentproto auth status  [--host <url>] [--json]
agentproto auth logout  [--host <url>]
agentproto auth cred set <id> <token> --api-base <url> [--audience <aud>] [--description <text>]
agentproto auth cred list [--json]
agentproto auth cred rm  <id>
```

Manages host-binding tokens — the JWT `agentproto serve --connect <host>`
sends to its tunnel host (Guilde, a self-hosted gateway, anything that
exposes the well-known metadata document). Tokens land in
`~/.agentproto/credentials.json`, mode 0600. See
[`../concepts/credentials.md`](../concepts/credentials.md) and
[`../reference/credentials-format.md`](../reference/credentials-format.md)
for the on-disk format.

These tokens are **not** per-adapter setup tokens. Adapter setup
secrets live in their own ledger (see [`setup.md`](./setup.md)).

## Mechanism

OAuth 2.0 Device Authorization Grant (RFC 8628) — same flow as
`gh auth login`, `gcloud auth login`, `stripe login`. Three round-trips:

1. **Discovery** — `GET <host>/.well-known/agentproto-host.json` for
   the device + token endpoints and `client_id`.
2. **Authorize** — `POST` device endpoint → `user_code` +
   `verification_uri`.
3. **Poll** — `POST` token endpoint with
   `grant_type=urn:ietf:params:oauth:grant-type:device_code` until the
   user approves in their browser; persist the bearer.

Hosts must expose `/.well-known/agentproto-host.json`. The CLI is
host-agnostic — any host that publishes the metadata works.

## `login`

```bash
# First login — host required
agentproto auth login --host wss://guilde.work

# Subsequent logins to the same host can omit --host
agentproto auth login

# Headless / SSH: don't try to open a browser, just print the URL
agentproto auth login --host wss://guilde.work --no-browser
```

Flags:

| Flag | Purpose |
|------|---------|
| `--host <url>` | The tunnel host URL. Most-recently-used wins when omitted. `wss://` and `ws://` are normalised to `https://` / `http://` for the discovery fetch. |
| `--label <name>` | Friendly device label shown on the host's approval UI. Default `username@hostname`. |
| `--scope <space-separated>` | OAuth scopes to request. Default `"tunnel:connect agent-cli:dispatch"`. |
| `--no-browser` | Skip `open` / `xdg-open` of the verification URL. The URL + user code are always printed. |

On success: `~/.agentproto/credentials.json` is created/updated with
`{ token, refreshToken?, scope, subject?, expiresAt, deviceLabel }`
keyed by the (trailing-slash-stripped) host URL.

## `status`

```bash
agentproto auth status
agentproto auth status --host wss://guilde.work
agentproto auth status --json
```

Prints one block per logged-in host with subject, scope, label, and a
relative expiry. `✓ active` vs `✗ EXPIRED` is computed locally; refresh
on expiry is handled by `serve` when reconnecting. `--json` emits a
machine-readable shape for scripts.

`status` exit code is `0` even when no credentials exist; absence is
not an error.

## `logout`

```bash
agentproto auth logout --host wss://guilde.work
# Single-host setup: --host can be omitted
agentproto auth logout
```

Best-effort server-side revocation if the host's discovery document
advertises a `revocation_endpoint` (RFC 7009). The local copy is
always deleted, even when the server call fails — you're logged out
on this machine either way.

When the credentials file ends up empty, it's removed.

## Examples

```bash
# Log into a guilde host, status, logout
agentproto auth login --host wss://guilde.work
agentproto auth status
agentproto auth logout --host wss://guilde.work

# Self-hosted gateway with a custom label
agentproto auth login --host wss://acme.internal --label "ci-runner-3"

# Use the stored token implicitly with serve
agentproto auth login --host wss://guilde.work
agentproto serve --connect wss://guilde.work   # picks up the token automatically
```

## Token resolution in `serve`

`agentproto serve --connect <host>` looks up the bearer in this order:

1. `--token <jwt>` flag
2. `$AGENTPROTO_TOKEN` env var
3. `~/.agentproto/credentials.json[<host>]`

An expired credential is still used — `serve` logs a warning so the
host's 401 surfaces a clearer error than a silent disconnect. Re-run
`agentproto auth login` to refresh.

## `cred` — broker credentials for child-MCP auth (0.5.0+)

`login`/`status`/`logout` above manage **host-binding** tokens (this daemon
↔ its tunnel host). `auth cred` is a separate, unrelated credential type:
tokens the daemon's **`CredentialBroker`** resolves into headers for MCP
servers a *spawned agent* mounts at start time (`credentialRef` on an
`agent_start`/`sessions start --mcp-servers-json` entry) — see
[`../concepts/credentials.md`](../concepts/credentials.md) for the broker
model and [`../reference/credentials-format.md`](../reference/credentials-format.md)
for both on-disk formats.

```bash
# Register a broker credential under id "my-api"
agentproto auth cred set my-api sk-xxxxx --api-base https://api.example.com --audience mcp

# List registered broker credentials (never prints the secret back)
agentproto auth cred list
agentproto auth cred list --json

# Remove one
agentproto auth cred rm my-api
```

`set` writes the secret to the OS keychain (not `credentials.json`) and
persists the non-secret provider definition (`apiBase`, `audience`,
`description`) to `~/.agentproto/auth-providers.json`. `--audience` defaults
to `"mcp"`. `list`/`rm` also accept `ls` / `remove`|`delete` as aliases.
A spawned agent's `mcpServers[].credentialRef` (matching the registered
`id`, optionally `"<id>/<account>"`) resolves through this broker at spawn
time — the resolved header is merged **on top of** any static `headers` on
that entry.
