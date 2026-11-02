# @agentproto/tunnel

The **Tunnel Provider primitive**: a stable public-URL contract plus the
shared plumbing every provider needs.

A provider owns remote tunnel state and the connector that publishes a local
target. This package defines the contract, the auth modes, the on-disk
credential store, and a base HTTP client - and nothing about sessions, apps,
or routing.

See the draft specification in
[`specs/proposals/aip-73/draft/TUNNEL.md`](../../specs/proposals/aip-73/draft/TUNNEL.md).

## Install

```sh
pnpm add @agentproto/tunnel
```

## Contract

```ts
import type { TunnelProvider } from "@agentproto/tunnel"

const provider: TunnelProvider = {
  slug: "acme",
  name: "Acme Tunnels",
  capabilities: {
    stableUrl: true,
    autostart: true,
    customDomain: true,
    requiresAuth: true,
    hasApi: true,
  },
  async create(input) { /* idempotent PUT */ },
  async list() { /* … */ },
  async delete(key) { /* idempotent */ },
  async status(key) { /* null when unknown */ },
  async health() { /* reports a state, never throws on transport failure */ },
}
```

Rules:

- `create` is idempotent on `key`.
- `delete` is idempotent; an unknown key is not an error.
- `status` returns `null` for an unknown key; transport/auth failures throw.
- `health` reports `active` / `degraded` / `error` / `unknown` instead of
  throwing.
- A provider never logs credentials or connector tokens.

## Auth modes

| Mode | Header | Notes |
| --- | --- | --- |
| `apiKey` | `Authorization: Bearer <apiKey>` | Long-lived server-issued keys. |
| `token` | `Authorization: Bearer <token>` | Caller-supplied short-lived token. |
| `oidc` | `Authorization: Bearer <accessToken()>` | Device login; refresh-and-retry once on `401`. |

## Credential store

Configuration lives outside the repo, one file per slug:

```
~/.agentproto/tunnel-creds/<slug>.json   # 0700 dir, 0600 file
```

```ts
import { readTunnelCredentials, writeTunnelCredentials } from "@agentproto/tunnel"

await writeTunnelCredentials("acme", { baseUrl: "https://api.acme.dev", apiKey: "sk-…" })
const creds = await readTunnelCredentials("acme")
```

Secrets are never written to logs or returned by list/status responses.

## Building a provider

```ts
import { TunnelClient, tunnelServiceUrl, type CreateTunnelInput } from "@agentproto/tunnel"

class AcmeProvider extends TunnelClient {
  async create(input: CreateTunnelInput) {
    const service = input.service ?? (input.target ? tunnelServiceUrl(input.target) : null)
    return this.request(`/v1/tunnels/${encodeURIComponent(input.key)}`, {
      method: "PUT",
      body: { service, hostnames: input.hostnames ?? [] },
    })
  }
}
```

## License

Apache-2.0 - see [LICENSE](./LICENSE).
