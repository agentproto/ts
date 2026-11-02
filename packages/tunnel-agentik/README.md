# @agentproto/tunnel-agentik

[`tunnels.agentik.net`](https://tunnels.agentik.net) implementation of the
Tunnel Provider contract from [`@agentproto/tunnel`](../tunnel).

- **Auth:** one bearer API key (`sk-…`), sent as
  `Authorization: Bearer <apiKey>`.
- **Endpoints:** `GET /v1/tunnels`, `PUT /v1/tunnels/:key`,
  `DELETE /v1/tunnels/:key`.
- **Deps:** none beyond `@agentproto/tunnel`.

See the draft specification in
[`specs/proposals/aip-73/draft/TUNNEL.md`](../../specs/proposals/aip-73/draft/TUNNEL.md).

## Install

```sh
pnpm add @agentproto/tunnel-agentik
```

## Usage

```ts
import { AgentikTunnelProvider } from "@agentproto/tunnel-agentik"

const provider = new AgentikTunnelProvider({
  apiKey: process.env.AGENTIK_TUNNEL_API_KEY!, // sk-…
})

const tunnel = await provider.create({
  key: "my-api",
  target: { host: "127.0.0.1", port: 3000 },
  hostnames: [], // let the service assign one
})

console.log(tunnel.publicUrl)
// start your connector with tunnel.connectorToken, then:
await provider.health()
```

## From stored credentials

```ts
import { readTunnelCredentials } from "@agentproto/tunnel"
import { agentikTunnelProviderFromCredentials } from "@agentproto/tunnel-agentik"

const creds = await readTunnelCredentials("agentik") // ~/.agentproto/tunnel-creds/agentik.json
const provider = agentikTunnelProviderFromCredentials(creds)
```

## Behaviour

| Call | Contract |
| --- | --- |
| `create` | `PUT /v1/tunnels/:key` - idempotent; replays on every start. |
| `list` | `GET /v1/tunnels` - accepts `{ tunnels }`, `{ items }`, or a bare array. |
| `status` | Derived from `list` (the API has no per-key `GET`); `null` when unknown. |
| `delete` | `DELETE /v1/tunnels/:key` - a `404` is not an error. |
| `health` | Probes `GET /v1/tunnels`; reports `active`/`error`, never throws. |

## License

Apache-2.0 - see [LICENSE](./LICENSE).
