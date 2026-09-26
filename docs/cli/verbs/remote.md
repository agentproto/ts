# `agentproto remote`

```text
agentproto remote enable  [--qr] [--provider quick] [--target-port <n>]
                          [--target-host <host>] [--json]
agentproto remote disable [--json]
agentproto remote status  [--json]
```

Publish this daemon's gateway to the internet via a Cloudflare tunnel, gated
with a bearer token minted for the session. CLI twin of the MCP
`remote_enable` / `remote_disable` / `remote_status` tools — same
`RemoteController` on the daemon, driven over its `/remote/*` HTTP routes.

Requires a running daemon ([`serve.md`](./serve.md) or
[`daemon.md`](./daemon.md)). Discovery follows the same layered order as
[`sessions.md`](./sessions.md): env override →
`~/.agentproto/runtime.json` (pid-checked) → the central registry → each
configured workspace's own `runtime.json`.

## Subverbs

### `enable`

Starts a tunnel via `POST /remote/enable`. By default it exposes **this
gateway** and mints a bearer token, printed exactly **once** — only its
SHA-256 hash is persisted (`.agentproto/remote.json`), so there is no way to
recover a lost token short of `remote disable` + `remote enable` again to
rotate it. Re-running `enable` while a tunnel is already active errors for
the same reason.

| Flag | Default | Description |
|------|---------|-------------|
| `--qr` | `false` | Render the response's `phoneUrl` (see below) as an in-terminal QR code. |
| `--provider <slug>` | `quick` | Tunnel backend. `quick` = Cloudflare Quick Tunnel — no API key, ephemeral `*.trycloudflare.com` URL. |
| `--target-port <n>` | this gateway's own port | Tunnel a *different* local service instead (e.g. a dev server). In this mode the daemon does **not** gate the traffic — no bearer token is issued, and `phoneUrl` is omitted — the upstream service must handle its own auth. |
| `--target-host <host>` | `127.0.0.1` | Host the tunnel forwards to. |
| `--json` | `false` | Emit the full `EnableResult` (see below) as JSON. |

```bash
agentproto remote enable --qr
```

```text
tunnel up  https://ensure-opera-satisfactory-embassy.trycloudflare.com
  bearer   bE2C9kyQ2fgcodKsG9nY2mPRF24razhjAZSlm4RPM38  (shown once — only its hash is persisted)
  mcp      https://ensure-opera-satisfactory-embassy.trycloudflare.com/mcp
  phone    https://ensure-opera-satisfactory-embassy.trycloudflare.com/apps/@agentik/session-chat/ui#token=bE2C9kyQ2fgcodKsG9nY2mPRF24razhjAZSlm4RPM38
[QR code of the phone URL]
```

### `disable`

Tears down the active tunnel and drops the bearer via `POST /remote/disable`.
Idempotent — calling it with no tunnel active is a no-op (`{"disabled":false}`).

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Emit `{"disabled":bool}` as JSON. |

### `status`

Read-only snapshot via `GET /remote/status` — provider, public URL, target,
supervised pid, createdAt, last error. **Never** re-shows the bearer token;
that only ever appears once, in `enable`'s own response.

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Emit the full status object as JSON. |

## `phoneUrl` — the QR/link target

`enable`'s response (and MCP `remote_enable`'s) includes a `phoneUrl`: one
link that gets a phone straight into a live view of this daemon, no typing
required. Its shape depends on what's installed:

- **`@agentik/session-chat` app installed** — `phoneUrl` points directly at
  it: `<tunnelUrl>/apps/@agentik/session-chat/ui#token=<t>`.
- **not installed** — falls back to the hosted panel:
  `https://cli.agentproto.sh/panel#daemon=<tunnelUrl>&token=<t>`.

In both shapes the token rides in the URL **fragment** (`#token=…`), never a
`?` query string. A fragment is never sent to a server — no `Referer`
header, no access/proxy log line, no CDN cache key — so the link is exactly
as safe to generate as it is to *display* (a screenshot or shoulder-surf is
the only leak surface, same as the bearer text printed above it). The
receiving page (session-chat, or the hosted panel) reads the fragment client
-side and immediately strips it from the address bar.

`phoneUrl` is omitted whenever `bearerToken`/`mcpEndpoint` are — i.e. for a
`--target-port` passthrough tunnel, since there's no daemon UI to link a
phone to in that mode.

## Security model

Once `remote enable` is active, the daemon is in **bearer mode**: every
request that did **not** originate on the loopback socket must present the
bearer — as `Authorization: Bearer <token>` on a normal request, or
`?token=<token>` on the SSE stream / PTY WebSocket upgrade (neither can set a
header). This applies uniformly to every route the daemon exposes (sessions,
conversations, `/mcp`, apps, …), with exactly three exceptions:

- `/health` — the public liveness probe.
- `/inbound/:slug` — gated by its own per-endpoint HMAC signature instead.
- `GET /apps/:appId/ui` (the static page shell only, not the APIs it calls)
  — so a phone can load the page before it has anywhere to put the token.

Critically, an allowlisted `Origin` header or the MCP-Apps widget embed
token (`?et=`) are **not** substitutes for the bearer here — those remain
browser-CSRF / local-widget guards, scoped to loopback. Before this was
tightened, a handful of routes accepted a spoofable `Origin` alone once a
tunnel was up; `curl` can set any `Origin` it likes once a request has
crossed a public tunnel, so anyone holding the tunnel URL could otherwise
have read session data or driven the daemon with no token at all. Loopback
traffic (same machine) is completely unaffected — it never needed the
bearer, before or after.

## Examples

```bash
# Publish this gateway and print the phone link + QR
agentproto remote enable --qr

# Tunnel a dev server instead — no bearer, no phoneUrl, upstream auths itself
agentproto remote enable --target-port 5173

# Check what's live
agentproto remote status

# Tear it down (rotates the token on the next enable)
agentproto remote disable
```

## See also

- [`serve.md`](./serve.md) — `--auth-token` for a *persistent* bearer, independent of `remote enable`'s ephemeral one
- [`tunnel.md`](./tunnel.md) — the general-purpose "expose any local port" surface (no gateway auth of its own)
- [`pair.md`](./pair.md) — end-to-end pairing over an untrusted rendezvous, an alternative to a public tunnel
