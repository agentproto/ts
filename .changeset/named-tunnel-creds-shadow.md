---
"@agentproto/runtime": patch
---

fix(runtime): stop a provider-level `credentialsFile` from shadowing a named
tunnel's own credentials

`setup_tunnel_provider cloudflare-named` stores one tunnel's
`{hostname, tunnelId, credentialsFile}` as the provider default. A later
`tunnel_create` for a *different* tunnelId that omitted `credentialsFile`
inherited the stored default — another tunnel's secret — so cloudflared failed
with `Unauthorized: Invalid tunnel secret`. `credsForDescriptor` now drops the
stored `credentialsFile` when the descriptor targets a different tunnelId and
carries no explicit one, letting the named provider fall back to the per-tunnel
`~/.cloudflared/<tunnelId>.json`. The single-tunnel BYO case (same tunnelId) and
an explicit descriptor `credentialsFile` are both preserved.
