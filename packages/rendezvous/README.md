# @agentproto/rendezvous

An **untrusted ciphertext splicer** for end-to-end agentproto daemon pairing.

The rendezvous is a deliberately dumb WebSocket broker. It matches two sockets
that present the same one-time token on the upgrade URL — one `side=daemon`, one
`side=client` — and from then on pipes their messages **byte-for-byte** in both
directions, parsing nothing beyond the upgrade URL.

The two peers run the `pair/v1` handshake (`@agentproto/secrets/pairing`) and an
AEAD channel (`@agentproto/acp/tunnel` `wrapE2E`) end-to-end, so the broker sees
only opaque ciphertext. It learns **token, IPs, message sizes, and timing** — it
can neither read nor forge traffic. See the repo's `DESIGN.md` §3.

## Run

```sh
agentproto rendezvous serve --port 8788      # via the main CLI
# or the standalone bin:
agentproto-rendezvous serve --port 8788
```

```
  clients dial:  ws://<host>:8788/v1?side=client&t=<token>
  daemons dial:  ws://<host>:8788/v1?side=daemon&t=<token>
```

## Hygiene

- **Park timeout** (default 120 s) — a lone arrival is closed if its counterpart
  never shows.
- **Idle timeout** (default 15 min) — a spliced pair with no traffic is torn
  down; any message resets it.
- **Max message size** (default 1 MiB) — oversized frames close the socket.
- **Per-IP rate limit** (default 120 attempts / 60 s) — keyed by the real socket
  address, never a forwardable header.
- **Concurrency guard** — a token that is parked or actively spliced refuses any
  third socket. Permanent single-use of *offer* tokens is enforced by the daemon
  (`verifyOfferToken` spends them); the broker frees a token once its splice
  closes so day-scoped reconnect tokens can be reused.

## Library

```ts
import { createRendezvousServer } from "@agentproto/rendezvous"

const server = createRendezvousServer({ parkTimeoutMs: 120_000 })
const { port } = await server.listen(8788, "0.0.0.0")
// ...
await server.close()
```

Self-host your own instance so no third party sits between your client and
daemon — defence in depth, since the broker only ever sees ciphertext.

## Hosting

See [DEPLOY.md](./DEPLOY.md) for:

- Docker deployment (prebuilt-dist, non-root)
- Kubernetes manifests
- TLS/HTTPS configuration (reverse proxy)
- Environment variables
- Health checks (`GET /healthz`)
- Scaling considerations

Quick Docker run:

```sh
# build the bundle first (standalone package, only dep is ws):
pnpm --filter @agentproto/rendezvous build
docker build -t agentproto-rendezvous packages/rendezvous
docker run -p 8788:8788 agentproto-rendezvous
```

Environment variables (all optional, see DEPLOY.md for defaults):

```sh
RENDEZVOUS_PORT=8788
RENDEZVOUS_HOST=0.0.0.0
RENDEZVOUS_IDLE_TIMEOUT_MS=900000
RENDEZVOUS_DEBUG=false
```
