---
"@agentproto/tunnel": minor
"@agentproto/tunnel-agentik": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Pick the hostname root of a provisioned tunnel. A provisioning service that serves several domains (the agentik tunnel service now serves `tunnel.agentik.net` and `agentproto.cloud`) assigns the hostname under the `root` the caller asks for, else under the API key's default.

- `@agentproto/tunnel`: `CreateTunnelInput.root?: string`.
- `@agentproto/tunnel-agentik`: `create` sends `root` in the PUT body when set.
- `@agentproto/runtime`: `tunnel_create` and `POST /tunnels` accept `root`. Only `cloudflare-provisioned` takes it (any other provider refuses it, as does an empty value); it is normalized, stored on the descriptor (`TunnelDescriptor.root`, persisted), handed to the provider as `TunnelIdentity.root`, and sent on every PUT (start, restore on boot, hostname swaps). `ensureKeyed` treats a root change as a config change: it restarts the tunnel and, without an explicit hostname request, lets the service assign a new name under the new root.
- `@agentproto/cli`: `agentproto tunnel create --root <domain>`; the usage text now lists `cloudflare-provisioned`.
