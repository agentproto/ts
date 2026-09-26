# @agentproto/pair-client

The browser side of agentproto E2E daemon pairing. A phone (or any browser
tab, worker or service worker) scans the QR from `agentproto pair offer --qr`,
pairs with the daemon through the rendezvous broker, and from then on reaches
it with a plain WHATWG `fetch`: streamed bodies and SSE included, every
request multiplexed over one end-to-end encrypted WebSocket. The broker only
ever sees ciphertext.

It speaks the same `pair/v1` handshake and `agentproto/tunnel/v1` frames as
the Node CLI (`agentproto pair accept` / `pair exec`), so the daemon can't
tell the two clients apart. It is browser-safe: no `node:` import, no
`Buffer`/`process`, WebCrypto only. A test bundles it for the browser and runs
a real pair + fetch in a realm that has only web globals.

## Pair

```ts
import { inspectOffer, pairFromOffer, createIndexedDbCredentialStore } from "@agentproto/pair-client"

const store = createIndexedDbCredentialStore()

// No network: what the QR says.
const info = await inspectOffer(location.href) // { fingerprint, rendezvousUrl, expiresAt }

// Handshake (spends the one-time offer), then show the daemon to the user.
const pending = await pairFromOffer(location.href, { store, clientName: "Jeremy's phone" })
showConfirm(pending.daemon.name, pending.daemon.fingerprint)
const credential = await pending.confirm() // stored; or pending.cancel()
```

**One origin per daemon.** `pair offer --qr` can point at a per-daemon page,
e.g. `https://{fp}.agentproto.cloud/pair` via `pairing.pairPage` or
`--pair-page` (the default is still `https://cli.agentproto.sh/pair`). A page
built for that should check that it's on its daemon's origin before pairing:

```ts
import { expectedPairHost, inspectOffer, PAIR_WEB_URL_TEMPLATE_CLOUD } from "@agentproto/pair-client"

const info = await inspectOffer(location.href)
if (location.host !== expectedPairHost(PAIR_WEB_URL_TEMPLATE_CLOUD, info.fingerprint)) {
  throw new Error("this pairing QR is for another daemon's page")
}
```

`pairFromOffer` accepts both offer forms: the web link
`https://cli.agentproto.sh/pair#v=1&rv=…` (the offer rides in the fragment,
which is never sent to a server) and the plain `agentproto://pair?…` URL.

The daemon records the pairing as soon as the handshake succeeds, the same as
for `pair accept`. `cancel()` only drops it on this side; remove the daemon's
record with `agentproto pair revoke`.

## Connect and fetch

```ts
import { connect } from "@agentproto/pair-client"

const client = connect(credential, { store })
client.onStateChange(({ state, error }) => render(state, error?.message))
// state: "connecting" | "open" | "offline" | "revoked" | "outdated" | "closed"

const res = await client.fetch("/sessions")          // a real Response
const events = await client.fetch("/events", { signal }) // res.body streams chunk by chunk
```

- **Multiplexing:** any number of concurrent requests share one channel.
- **Streaming:** `http_response_head` resolves the `Response`. The body is a
  `ReadableStream` fed by each `http_response_chunk` as it arrives, so SSE works.
- **Abort:** aborting the signal, or cancelling the body, sends `http_cancel` and
  the daemon stops its upstream request.
- **Reconnect:** jittered exponential backoff, capped (500 ms → 30 s by
  default). In-flight requests fail with `TunnelClientError{code:"disconnected"}`.
  New requests wait for the reconnect, or fail with `offline` after
  `requestWaitMs`. A ping/pong keepalive catches half-open sockets.
- **Revocation:** after `agentproto pair revoke` the daemon answers this
  pairing with an authenticated `pairing_revoked` frame inside the E2E channel.
  The client goes to `revoked`, stops retrying, and every call rejects with
  `TunnelClientError{code:"revoked"}`: "this device was unpaired from
  &lt;daemon&gt;; scan a new pairing QR". The broker can't forge that signal.

- **Protocol:** pair/v2. Each connection derives a *route* token and an *auth*
  token (from the offer secret, or from the pair root and the day). Only the
  route goes on the broker URL; the auth is sealed into the hello. A v1 offer,
  or a credential stored before v2, gives `TunnelClientError{code:
  "protocol_outdated"}` (state `outdated`) and is never dialed: upgrade the
  daemon and scan a new QR.

The daemon keeps one standing channel per epoch slot for each pairing, so
share one `TunnelClient` per credential. Don't connect twice.

## In a service worker

The package runs in a service worker: `WebSocket`, `crypto.subtle`,
`indexedDB`, `fetch` types and streams are all there. Keep one client per
credential at module scope and use it for every `fetch` event:

```ts
import { connect, createIndexedDbCredentialStore } from "@agentproto/pair-client"

const store = createIndexedDbCredentialStore()
const clients = new Map<string, ReturnType<typeof connect>>()

async function clientFor(id: string) {
  let c = clients.get(id)
  if (!c || c.state === "closed") {
    const cred = await store.get(id)
    if (!cred) throw new Error("not paired")
    const prefix = `/d/${id}`
    c = connect(cred, { store, mapPath: url => url.pathname.slice(prefix.length) + url.search })
    clients.set(id, c)
  }
  return c
}

self.addEventListener("fetch", (event: FetchEvent) => {
  const m = new URL(event.request.url).pathname.match(/^\/d\/([0-9a-f]{16})\//)
  if (!m) return
  event.respondWith(clientFor(m[1]!).then(c => c.fetch(event.request)))
})
```

The browser may stop an idle service worker. The next `fetch` event then
builds a new client, which reconnects in about one round trip.

## Credential storage

`CredentialStore` is `{ get, put, delete, list }`:

- `createIndexedDbCredentialStore()` works in a window or a worker, scoped to
  the origin.
- `createMemoryCredentialStore()` is for tests.

Nothing is written to localStorage. The pair root is imported as a
**non-extractable** WebCrypto HKDF `CryptoKey`, and IndexedDB stores the key
object as-is. Script can derive the day's routing token with it but can't
read the secret back out.
