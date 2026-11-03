# @agentproto/tunnel

## 0.2.0

### Minor Changes

- c333e4e: Add `@agentproto/tunnel` (Tunnel Provider contract, auth modes, credential store, base HTTP client) and `@agentproto/tunnel-agentik` (tunnels.agentik.net provider). Implements the draft `tunnel/v1` spec proposed in agentproto/agentproto#150.
- b0d7203: Pick the hostname root of a provisioned tunnel. A provisioning service that serves several domains (the agentik tunnel service now serves `tunnel.agentik.net` and `agentproto.cloud`) assigns the hostname under the `root` the caller asks for, else under the API key's default.

  - `@agentproto/tunnel`: `CreateTunnelInput.root?: string`.
  - `@agentproto/tunnel-agentik`: `create` sends `root` in the PUT body when set.
  - `@agentproto/runtime`: `tunnel_create` and `POST /tunnels` accept `root`. Only `cloudflare-provisioned` takes it (any other provider refuses it, as does an empty value); it is normalized, stored on the descriptor (`TunnelDescriptor.root`, persisted), handed to the provider as `TunnelIdentity.root`, and sent on every PUT (start, restore on boot, hostname swaps). `ensureKeyed` treats a root change as a config change: it restarts the tunnel and, without an explicit hostname request, lets the service assign a new name under the new root.
  - `@agentproto/cli`: `agentproto tunnel create --root <domain>`; the usage text now lists `cloudflare-provisioned`.

- 84f99bf: Export `SPEC_NAME = "tunnel/v1"`, the spec id AIP-73 is registered under in the canonical names registry. The canonical spec pin moves to agentproto/agentproto `a883a2d` in the same change, since the constant and the registry entry only pass `check-names` together.
