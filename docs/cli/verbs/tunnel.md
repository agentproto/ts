# `agentproto tunnel`

```text
agentproto tunnel create --port <n> [--provider <slug>] [--name <slug>]
                         [--label <text>] [--host <host>] [--autostart]
                         [--hostname <fqdn>] [--tunnel-id <id>]
                         [--credentials-file <path>] [--ttl <1h|24h|7d>]
                         [--public] [--json]
agentproto tunnel list   [--active] [--json]
agentproto tunnel stop   <id-or-name> [--json]        (alias: delete, rm)
agentproto tunnel purge  <id-or-name> [--json]
agentproto tunnel login  <provider> [--logout] [--no-wait] [--json]
agentproto tunnel add-hostname    <id-or-name> <fqdn> [--json]
agentproto tunnel remove-hostname <id-or-name> <fqdn> [--json]
agentproto tunnel revoke <id-or-name> [--json]
agentproto tunnel status <id-or-name> [--json]
```

Manage public tunnels via the daemon's `/tunnels` HTTP routes. Tunnels
expose a local port to the internet through Cloudflare or Ngrok, driven
by the daemon — no separate tunnel CLI process to manage.

## Private by default

Unless `--public` is passed, an access guard sits in front of the target.
The bare tunnel host (`publicUrl`) rejects every request that lacks a valid
token or cookie — share the printed `url` instead, a signed link (random
bearer token, default TTL 24h). The guard also adds `X-Robots-Tag: noindex`
and blocks a dev server's own `/@fs/` paths and `*.map` source maps.
`tunnel revoke` invalidates the current link instantly without stopping the
tunnel and returns a fresh one; `tunnel stop` tears everything down.

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
| `cloudflare-managed` | The daemon creates, maintains and deletes the Cloudflare tunnel, its ingress and its DNS record through the Cloudflare API. Needs `--hostname` on a zone configured once (see below). |
| `cloudflare-provisioned` | A remote provisioning service creates the tunnel for you after you log in (`tunnel_login`, OIDC device flow). No Cloudflare token on this machine; `--hostname` is optional (the service assigns one). |
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

### Managed Cloudflare tunnels (`cloudflare-managed`)

You declare the desired state (local port + hostname); the daemon makes
Cloudflare match it, on every start:

1. finds the tunnel `agentproto-managed-<name>-<id8>` (or `…-<id>` when unnamed) or creates it
   (`config_src: "cloudflare"`) — it always lists first, so replays never
   duplicate;
2. writes the tunnel's remote ingress: one rule per hostname →
   `http://127.0.0.1:<port>` (or the access guard's port for a private
   tunnel), then `http_status:404`;
3. upserts a proxied `CNAME <hostname> → <tunnel-id>.cfargotunnel.com`
   with the comment `managed by agentproto tunnel engine`;
4. runs `cloudflared tunnel run` under a supervisor (restart with
   exponential backoff, gives up after a crash loop). The connector token
   is fetched from the API on each start, held in memory only and passed
   through the `TUNNEL_TOKEN` env var — never argv, never disk, never logs;
5. probes `https://<hostname>/` every 60 s. Any answer from the app
   (including the guard's 401 or the app's 404) is `active`; a Cloudflare
   edge 5xx (502/530…) or a network error is `degraded`; a cloudflared
   crash loop is `error`. `tunnel status` shows it as `health`.

**Ownership.** The engine only touches tunnels named `agentproto-managed-…`
and DNS records carrying its comment. If any other record already exists for
the hostname, create fails and the record is left alone. It also refuses to
take over a hostname that is still routed to another live managed tunnel.

**Configure once** via the `setup_tunnel_provider` MCP tool, slug
`cloudflare-managed`. The config is stored 0600 in
`~/.agentproto/tunnel-creds/cloudflare-managed.json`:

| Field | Required | Value |
|-------|----------|-------|
| `zones` | yes | JSON array, one entry per zone: `{ "zone", "accountId", "tokenRef", "zoneId"?, "maxLabels"? }` |
| `zoneTokens` | no | JSON object `{ "<key>": "<api token>" }`, for `tokenRef: "stored:<key>"` (SENSITIVE, never echoed) |

```json
{
  "slug": "cloudflare-managed",
  "zones": "[{\"zone\":\"example.com\",\"accountId\":\"<account id>\",\"tokenRef\":\"env:CF_TOKEN_EXAMPLE_COM\"},{\"zone\":\"example.dev\",\"accountId\":\"<account id>\",\"tokenRef\":\"keychain:cloudflare/exampledev\",\"maxLabels\":2}]"
}
```

- `tokenRef` is a **reference**, never the token: `env:<VAR>` (daemon
  env), `file:<path>` (must be owner-only, `chmod 600`),
  `keychain:<service>` (OS keychain), or `stored:<key>` (from
  `zoneTokens`). Each token needs *Account › Cloudflare Tunnel › Edit*,
  *Zone › DNS › Edit* and *Zone › Zone › Read* (the last one is not needed
  if you set `zoneId`).
- The zone is picked by hostname suffix (longest match wins). A hostname
  that matches no zone fails with the list of configured zones.
- `maxLabels` (default `1`) caps how deep a hostname may be under the zone.
  Without Advanced Certificate Manager the edge certificate only covers
  `*.<zone>`, so `relay.example.com` works but `wa.relay.example.com` is
  rejected unless you raise `maxLabels` for that zone.
- All hostnames of one tunnel must live in zones of the same account.

**Hostname swap.** `tunnel add-hostname <tunnel> <new-fqdn>` routes the new
hostname to the same tunnel (ingress + CNAME) and makes it the primary, while
the old one keeps working. `tunnel status` lists both under `hostnames`, with
health per hostname. Once consumers have moved,
`tunnel remove-hostname <tunnel> <old-fqdn>` retires the old hostname. The new
hostname can be on another configured zone in the same account.

**Stop vs purge.** `tunnel stop` only stops cloudflared. The tunnel and DNS
stay, so the URL is the same after the next start. `tunnel purge` stops
cloudflared, deletes the engine's CNAME(s), clears the tunnel's connections
and deletes the tunnel, tolerating anything that is already gone. If the
Cloudflare delete fails, the descriptor is kept with `lastError` so you can
retry.

## Subverbs


### Provisioned Cloudflare tunnels (`cloudflare-provisioned`)

For machines that must not hold a Cloudflare token (an end user's laptop).
A provisioning service you run owns the Cloudflare account and zone, and the
daemon only ever receives the connector token of its own tunnel.

1. Configure once with `setup_tunnel_provider`, slug `cloudflare-provisioned`.
   The fields are `provisionerUrl`, `oidcIssuer`, `oidcClientId` and the
   optional `oidcScopes`. Both URLs must use https; loopback is allowed for
   development.
2. Log in with the `tunnel_login` MCP tool (`{ slug: "cloudflare-provisioned" }`).
   It returns a short code and a URL. Approve it in a browser; the daemon
   finishes in the background, and calling `tunnel_login` again shows the
   state. The OIDC session is kept owner-only in
   `~/.agentproto/tunnel-sessions/cloudflare-provisioned.json` and refreshed
   automatically. `logout: true` forgets it. The client must be a public
   ("native") OIDC client with the Device Code and refresh-token grants
   enabled.
3. Run `tunnel_create({ provider: "cloudflare-provisioned", targetPort: … })`.
   `hostname` is an optional request; the service decides what it actually
   routes and returns it.

Everything after provisioning — the supervised `cloudflared`, the token kept
in the environment only, health, `tunnel_add_hostname` / `tunnel_remove_hostname`
and `tunnel purge` — works as for `cloudflare-managed`.

**Provisioner contract (v1).** Every call carries
`Authorization: Bearer <OIDC access token>`.

| Call | Body | Response |
|------|------|----------|
| `PUT {provisionerUrl}/v1/tunnels/{key}` | `{ "service": "http://127.0.0.1:<port>" \| null, "hostnames": ["…"] }` | `200 { "tunnelId", "hostnames": ["…"], "token" }` |
| `DELETE {provisionerUrl}/v1/tunnels/{key}` | — | 2xx, or 404 if already gone |

- `key` is the daemon's stable tunnel id; the service namespaces it per user.
- An empty `hostnames` means "assign me one".
- `service: null` means the tunnel isn't running locally; keep the current origin.
- `PUT` is idempotent and replayed on every start.
- Errors are JSON `{ error, message, checkoutUrl? }`:
  - **401:** the daemon refreshes its token once, then asks for `tunnel_login`.
  - **402:** payment is required; `checkoutUrl` is shown to the user.
  - **409:** the hostname is taken.
- The service must verify the bearer token (issuer, audience/client id,
  expiry), and should only accept loopback `service` origins.

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
| `--hostname <fqdn>` | — | (Named, managed) Stable FQDN for the tunnel. |
| `--tunnel-id <id>` | — | (Named) Pre-provisioned Cloudflare tunnel id. |
| `--credentials-file <path>` | — | (Named) Path to Cloudflare credentials JSON. |
| `--ttl <dur>` | `24h` | How long the signed link stays valid (`1h`, `24h`, `7d`; clamped to 1 minute – 30 days). Ignored with `--public`. |
| `--public` | `false` | Opt out of the access guard: anyone with the URL can reach the tunnel (no token, no TTL, no revoke). The descriptor carries a `warning`. |
| `--json` | `false` | Emit the tunnel descriptor as JSON. |

The descriptor's `url` is the link to share (the signed link for a private
tunnel); `access` is `private` or `public`, and `expiresAt` is the link's
expiry.

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

### `purge <id-or-name>`

Stops the tunnel and deletes what its provider created remotely, via
`DELETE /tunnels/:id?purge=true`. For `cloudflare-managed` that's the CNAME(s)
and the Cloudflare tunnel; for the other providers it is the same as `stop`,
and the descriptor is also forgotten. This cannot be undone.

### `login <provider>`

Logs the daemon in to a provider that acts on your behalf (`cloudflare-provisioned`)
with the OIDC device flow, via `POST /tunnels/login`. It's the same thing as
the `tunnel_login` MCP tool.

It prints a URL and a short code. Open the URL, confirm the code, and the
command waits until you've approved. No token is ever printed.

| Flag | Default | Description |
|------|---------|-------------|
| `--logout` | `false` | Forget the stored session. |
| `--no-wait` | `false` | Print the URL and code, then return; the daemon keeps polling in the background. |
| `--json` | `false` | Emit the login state as JSON. |

For local UIs that drive the daemon over HTTP, there are two more routes:
- `GET /tunnels/login?slug=<provider>` reads the login state and never starts a login.
- `PUT /tunnels/providers/<provider>` with the setup fields as JSON does the same as `setup_tunnel_provider`.

### `add-hostname <id-or-name> <fqdn>` / `remove-hostname <id-or-name> <fqdn>`

Hostname swap for `cloudflare-managed`, via `POST /tunnels/:id/hostnames`
and `DELETE /tunnels/:id/hostnames/:fqdn`. See *Managed Cloudflare tunnels*.

### `revoke <id-or-name>`

Invalidates every link and cookie issued so far for a private tunnel,
without stopping it, via `POST /tunnels/:id/revoke`. Rotates the guard's
signing secret and prints a fresh signed `url` on a new TTL window. Errors
for a `--public` tunnel (no guard) or a tunnel that is not active.

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

# Managed Cloudflare tunnel — created through the API, survives restarts
agentproto tunnel create --port 8081 --name wa-relay \
  --provider cloudflare-managed --hostname wa.example.com --autostart --public

# Move it to another hostname with an overlap window, then retire the old one
agentproto tunnel add-hostname wa-relay wa.example.dev
agentproto tunnel remove-hostname wa-relay wa.example.com

# Delete the managed tunnel and its DNS record
agentproto tunnel purge wa-relay

# List active tunnels
agentproto tunnel list --active

# Content that is meant to be public (no access guard)
agentproto tunnel create --port 4000 --public

# Rotate a leaked link without stopping the tunnel
agentproto tunnel revoke vite-preview

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