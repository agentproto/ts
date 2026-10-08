# `agentproto tunnel`

```text
agentproto tunnel create --port <n> [--provider <slug>] [--name <slug>]
                         [--label <text>] [--host <host>] [--autostart]
                         [--hostname <fqdn>] [--tunnel-id <id>]
                         [--credentials-file <path>] [--ttl <1h|24h|7d>]
                         [--public] [--json]
agentproto tunnel list   [--active] [--json]
agentproto tunnel stop   <id-or-name> [--json]        (alias: delete, rm)
agentproto tunnel revoke <id-or-name> [--json]
agentproto tunnel status <id-or-name> [--json]
```

Manage public tunnels via the daemon's `/tunnels` HTTP routes. Tunnels
expose a local port to the internet through Cloudflare or Ngrok, driven
by the daemon — no separate tunnel CLI process to manage.

**Private by default.** Unless `--public` is passed, a signed-link access
guard (random bearer token, 24h TTL by default, `X-Robots-Tag: noindex`,
blocks `/@fs/` and source maps) sits in front of the tunnel. Share the
descriptor's `url` (the signed link), not the bare `publicUrl`, which
rejects requests without a valid token or cookie. `tunnel revoke`
invalidates the link instantly without stopping the tunnel.

Requires a running daemon ([`serve.md`](./serve.md) or
[`daemon.md`](./daemon.md)). Discovery follows the same layered order as
[`sessions.md`](./sessions.md): env override → `~/.agentproto/runtime.json`
(pid-checked) → the central registry → each configured workspace's own
`runtime.json`.

## Providers

| Provider | Description |
|----------|-------------|
| `cloudflare-quick` (default) | Cloudflare Quick Tunnel — no API key, ephemeral `*.trycloudflare.com` URL (changes every run). |
| `cloudflare-named` | A pre-provisioned Cloudflare tunnel bound to a stable hostname. Needs `--hostname` and `--tunnel-id`. |
| `ngrok` | Ngrok tunnel — configure its authtoken first via the `setup_tunnel_provider` MCP tool. |
| Third-party | Any installed `@scope/agentproto-adapter-<slug>` provider. |

Legacy aliases `quick` and `named` are accepted for the Cloudflare
providers.

### Named tunnel one-time setup

```bash
cloudflared tunnel create <name>
cloudflared tunnel route dns <name> <hostname>
```

Then reference it with `--provider cloudflare-named --hostname … --tunnel-id …`.

## Subverbs

### `create`

Creates a tunnel via `POST /tunnels`.

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | *(required)* | Local port to expose (1–65535). |
| `--provider <slug>` | `cloudflare-quick` | Tunnel provider. |
| `--name <slug>` | — | Stable name for referencing the tunnel. |
| `--label <text>` | — | Human-readable label. |
| `--host <host>` | `127.0.0.1` | Target host to forward to. |
| `--autostart` | `false` | Relaunch the tunnel automatically when the daemon boots. |
| `--hostname <fqdn>` | — | (Named) Stable FQDN for the tunnel. |
| `--tunnel-id <id>` | — | (Named) Pre-provisioned Cloudflare tunnel id. |
| `--credentials-file <path>` | — | (Named) Path to Cloudflare credentials JSON. |
| `--ttl <dur>` | `24h` | How long the signed link stays valid (`1h`, `24h`, `7d`). Ignored with `--public`. |
| `--public` | `false` | Opt out of the access guard: reachable by anyone with the URL, no token, no TTL, no revoke. |
| `--json` | `false` | Emit the tunnel descriptor as JSON. |

### `list`

Lists tunnels known to the daemon via `GET /tunnels`.

| Flag | Default | Description |
|------|---------|-------------|
| `--active` | `false` | Show only active tunnels. |
| `--json` | `false` | Emit an array of tunnel descriptors. |

### `stop <id-or-name>`

Stops a tunnel via `DELETE /tunnels/:id`. Accepts `delete` and `rm` as
aliases.

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Emit `{"ok":bool,"tunnelId":str}` as JSON. |

### `revoke <id-or-name>`

Invalidates every link and cookie issued so far for a private tunnel,
without stopping it, via `POST /tunnels/:id/revoke`. Prints a fresh signed
`url`. Fails for a tunnel created with `--public` (no guard to revoke) or
one that isn't active.

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Emit the updated tunnel descriptor as JSON. |

### `status <id-or-name>`

Prints a detailed descriptor for one tunnel via `GET /tunnels/:id`.

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Emit the full descriptor as JSON. |

## Examples

```bash
# Quick tunnel — ephemeral URL, no credentials
agentproto tunnel create --port 3000

# Quick tunnel with a name for later reference
agentproto tunnel create --port 5173 --name vite-preview --json

# Named Cloudflare tunnel (pre-provisioned, stable hostname, autostart)
agentproto tunnel create --port 3040 --name prod-preview \
  --provider cloudflare-named \
  --hostname preview.example.com --tunnel-id my-tunnel \
  --autostart

# List active tunnels
agentproto tunnel list --active

# Inspect one
agentproto tunnel status prod-preview

# A link leaked — invalidate it and get a fresh one
agentproto tunnel revoke prod-preview

# Intentionally public content (no access guard)
agentproto tunnel create --port 8080 --public

# Tear down
agentproto tunnel stop prod-preview
```

## See also

- [`serve.md`](./serve.md) — daemon that hosts tunnels
- [`daemon.md`](./daemon.md) — managed background daemon with autostart
- [`auth.md`](./auth.md) — configure Ngrok/provider credentials