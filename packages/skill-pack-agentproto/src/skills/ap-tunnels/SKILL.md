---
name: ap-tunnels
description: Expose a local port publicly via agentproto tunnels — tunnel_create on cloudflare-quick/cloudflare-named/ngrok, tunnel_list to avoid duplicates, remote_enable to publish the MCP gateway bearer-gated. Trigger when asked to share a dev server, tunnel localhost, get a public URL, or expose the agent gateway remotely.
---

# ap-tunnels

## When to use

- A local dev server must be reachable from the internet (webhook targets, demo links, mobile testing).
- You want to drive this daemon's MCP gateway from a remote client.
- A tunnel is stuck or duplicated and needs to be found and rotated.

## tunnel_*: expose any local port

```json
// 1. Always check first — one tunnel per port; duplicates just fail
tunnel_list({ "onlyActive": true })

// 2. Quick tunnel: no account, ephemeral URL, ready in seconds
tunnel_create({ "targetPort": 3000, "provider": "cloudflare-quick", "label": "vite-preview" })
// → { "tunnelId": "uuid", "url": "https://random-words.trycloudflare.com", ... }

// 3. Named tunnel: stable hostname you provisioned once
tunnel_create({
  "targetPort": 3000,
  "provider": "cloudflare-named",
  "hostname": "app.example.com",
  "tunnelId": "11111111-2222-3333-4444-555555555555",
  "credentialsFile": "~/.cloudflared/<tunnelId>.json",
  "autostart": true
})

// 4. Inspect / stop (stop is idempotent)
tunnel_status({ "tunnelId": "uuid" })
tunnel_stop({ "tunnelId": "uuid" })
```

`tunnel_create` does **NOT** gate traffic with auth — it is a pure passthrough; whatever service is on `targetPort` handles its own authentication. `list_tunnel_adapters` enumerates the installed tunnel backends and their capabilities. Providers with credentials (e.g. ngrok authtokens, named-tunnel ids) are configured once, stored sensitively, and never echoed.

## remote_enable: publish the gateway itself

```json
remote_enable({ "provider": "quick" })            // bearer-gated MCP gateway, URL shown once
remote_status({})                                  // provider, public URL, createdAt — no token
remote_disable({})                                 // tear down + drop bearer auth (idempotent no-op if off)
```

`remote_enable` with no `targetPort` publishes **this MCP gateway** and gates it with a bearer token. Re-running while active errors — call `remote_disable` first to rotate.

## Gotchas

- **Bearer token is shown ONCE** at `remote_enable` — store it immediately; only its hash persists.
- Quick tunnels get a **NEW URL every relaunch** (daemon restart, tunnel_stop/create). For anything that must survive, use a named tunnel with `autostart: true`.
- `tunnel_list` before `tunnel_create` — creating a second tunnel for the same port is a silent no-op at best and a confusing duplicate at worst.
- `tunnel_stop` and `tunnel_status` accept either the tunnel id or the friendly `name` set at create time.
- A tunnel exposes the whole port, not just one route — make sure the service behind it has its own auth before sharing the URL.

## Pointers

- agentproto — daemon overview.
- ap-import-mcp — remote clients consuming this gateway typically mount it as an MCP server.
- ap-spawn-agent — sessions spawned with a remote `mcpServers` ref point at the published URL.
- ap-transmit — for inbound webhooks that need a public HTTPS endpoint.
