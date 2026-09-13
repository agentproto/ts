# `agentproto auth`

```text
agentproto auth login   [--host <url>] [--label <name>] [--no-browser] [--scope <s>]
agentproto auth status  [--host <url>] [--json]
agentproto auth logout  [--host <url>]
agentproto auth provider <set|list|rm> …   — LLM provider API keys
agentproto auth cred     <set|list|rm> …   — broker creds for child-MCP auth
agentproto auth profile <create|list|rm|import|set-models|set-enabled|refresh-models> …
                                           — named auth profiles (subscriptions / API keys)
agentproto auth discover [--endpoint <e>] [--json]
                                           — scan this host for importable credentials
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

If the credential from step 3 is expired and stores a `refreshToken`,
`serve` first attempts a silent non-interactive refresh (no device-code
ceremony). Only if that fails does it log a warning and fall back to the
stale token — the host's 401 then surfaces a clearer error than a silent
disconnect. Re-run `agentproto auth login --host <host>` if silent
refresh fails or no refresh token is stored.

## `provider` — LLM provider API keys

Stores provider API keys the `models` verb and adapters resolve at spawn
time:

```bash
agentproto auth provider set anthropic sk-ant-…
agentproto auth provider set openrouter sk-or-… --base-url https://…
agentproto auth provider list [--json]
agentproto auth provider rm openai
```

## `profile` — named auth profiles

Named auth profiles (`~/.agentproto/auth-profiles.json` + OS keychain)
attach a billing credential to a name so spawns can reference it with
`--access-profile <id>` / `agent_start.access.profileRef`. All `profile`
subcommands operate daemon-less.

### `profile create <id> <endpoint>`

```bash
op paste | agentproto auth profile create work-anthropic anthropic \
    --method oauth-bearer --label "work sub"
agentproto auth profile create gateway-or openrouter \
    --method api-key --credential-env OR_API_KEY
```

Flags:

| Flag | Description |
|------|-------------|
| `--method <oauth-bearer\|api-key>` | Required. How the credential is used at spawn time. |
| `--label <text>` | Human-readable name for the profile. |
| `--source <name>` | Source tag for oauth-bearer profiles (enables self-refreshing). |
| `--credential-file <path>` | Read the credential from a file. |
| `--credential-env <VAR>` | Read the credential from an environment variable. |
| `--credential-ref <slot>` | Reference an existing keychain slot directly. |
| `--json` | Emit the created profile as JSON. |

The credential itself is **never** a command-line argument — pipe it on
stdin, or supply it via `--credential-file` / `--credential-env`.

### `profile list [--endpoint <e>] [--json]`

```bash
agentproto auth profile list
agentproto auth profile list --endpoint anthropic --json
```

Lists all named profiles (non-secret metadata only). `--endpoint` filters
by provider endpoint (e.g. `anthropic`, `openrouter`).

### `profile rm <id>`

```bash
agentproto auth profile rm work-anthropic
```

Removes the profile and clears its keychain slot (when no other profile
references the same slot).

### `profile import <origin> <endpoint>`

```bash
agentproto auth profile import claude-code anthropic
agentproto auth profile import claude-code anthropic --id my-claude --label "Claude Pro"
```

Materializes a credential discovered by `agentproto auth discover` into a
named profile. Source-backed where the origin self-refreshes. Origins:
`claude-code`, `hermes-config`, `env`, `codex`, `gemini`.

| Flag | Description |
|------|-------------|
| `--id <id>` | Profile id to use instead of the auto-derived default. |
| `--label <text>` | Human-readable label. |

### `profile set-models <id> <all|allow> [<ids…>]`

```bash
agentproto auth profile set-models work-anthropic allow claude-code/claude-sonnet-4
agentproto auth profile set-models work-anthropic all
```

Curates which model ids the profile is eligible for. `allow` narrows to
exactly the listed ids; `all` clears the curation (all models for the
endpoint).

### `profile set-enabled <id> <true|false>`

```bash
agentproto auth profile set-enabled work-anthropic false
```

Toggles a whole profile. A disabled profile is skipped by the catalog
and spawn resolution — effectively suspended without deleting it.

### `profile refresh-models <id>`

Re-syncs a named auth profile's curated model ids against the current
catalog:

```bash
agentproto auth profile refresh-models openrouter-api --json
```

Explicit and opt-in; refuses a `mode: "all"` profile (nothing to
refresh).

## `discover`

```bash
agentproto auth discover
agentproto auth discover --endpoint anthropic --json
```

Scans this host for credentials that can be imported into named profiles.
Looks for: claude-code login files, hermes config, environment variables,
codex auth, gemini login. Each hit prints:

```text
origin: claude-code   endpoint: anthropic
  import: agentproto auth profile import claude-code anthropic
```

`--endpoint <e>` filters results to a specific provider endpoint.
`--json` emits the raw `{ credentials: […] }` array.

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
