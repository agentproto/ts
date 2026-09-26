# Pairing (end-to-end, over an untrusted rendezvous)

**Pairing** is a persistent, end-to-end-encrypted relationship between a
*client* (the CLI today; mobile/web later) and a *daemon* (`agentproto serve`).
Its goal is to let a client reach a daemon that only ever dials **outbound**,
through a broker that **cannot read or forge the traffic** — bootstrapped by a
single offer URL / QR code, with no accounts, no DNS, no inbound ports, and no
trusted middlebox.

This page describes what exists **after Phase 2**: the cryptographic library
layer (Phase 1), plus the rendezvous broker, the `pair` CLI/MCP verbs, on-disk
persistence, reconnect epochs, and autoconnect on boot. Pairing also works with
no config — `pair offer` defaults to the **hosted broker**
`wss://rdv.agentproto.sh/v1`, which relays only ciphertext (see [The hosted
default](#the-hosted-default)). The mobile deep-link page and the pairing spec
(AIP-59 (draft, agentproto/agentproto#41)) remain Phase 3 — see *Status* at the bottom.

Jump to the commands: [`pair`](../verbs/pair.md) (offer / accept / ls / revoke /
exec) and [`rendezvous`](../verbs/rendezvous.md) (self-host the broker).

## Why

Every remote path into a daemon today trusts an intermediary with plaintext:

| Surface | Intermediary sees | Auth |
| --- | --- | --- |
| `tunnel_create` (cloudflare/ngrok) | everything (TLS terminates at their edge) | daemon bearer |
| `remote_enable` (quick tunnel) | everything | per-enable bearer |
| `serve --connect` reverse tunnel | everything (host terminates the WS, frames are plaintext) | `apt_` token at upgrade |

Pairing removes the trusted middle: the broker splices two sockets and relays
ciphertext byte-for-byte. It learns the **route token** each peer dials, the
peers' IPs, timing, and ciphertext sizes — never the content, and it cannot
inject or alter frames. A route token is an opaque meeting-point name that
authenticates nothing (see [Route and auth tokens](#route-and-auth-tokens)).

## Threat model

| Adversary | Capability | Mitigation |
| --- | --- | --- |
| Rendezvous operator (or anyone logging its upgrade URLs) | read / modify / replay bytes; learns every route token; can connect to any route as a client and send a well-formed hello sealed to the daemon's public key | E2E AEAD + transcript-bound signature; the daemon authorises only a sealed **auth** token that is a separate one-way HKDF output, not derivable from the route — a hello presenting the route (or any guess) is refused, spends no offer, and is never served |
| Offer-URL thief (pre-expiry) | pair as a new client | short TTL + single-use offer secret; daemon shows name + fingerprint on accept; `pair revoke` |
| Evil "daemon" (wrong QR) | impersonate the daemon | fingerprint shown at offer and accept; keys pinned after first pair |
| Stolen client credstore | act as that client | per-client revocation; `pairings.json` audit (`lastSeen`); browser pair root is a non-extractable `CryptoKey` |
| Broker DoS | drop / delay traffic | reconnect-with-backoff; self-host escape hatch |
| Broker fakes "revoked" | make a client give up / forget its pairing | the `pairing_revoked` signal only counts inside the E2E channel, after the daemon's signature verified; a broker close code or reason never does |

Out of scope for v1: post-compromise security (no ratchet — rekey on reconnect
only), multi-device sync, and broker federation.

## What Phase 1 ships (the library layer)

Three pieces, all built on X25519, Ed25519, HKDF-SHA256 and AES-256-GCM with
zero native dependencies. The primitives sit behind a small async crypto
interface with two implementations — `node:crypto` (the default in Node) and
WebCrypto (the default in a browser) — so one implementation of the protocol
runs in both, byte-for-byte identically. The browser-safe entry points are
`@agentproto/secrets/pairing/browser` (handshake, offer codec, seal, identity
signatures) and `@agentproto/acp/tunnel/browser` (frame codec, `wrapE2E`,
handshake-over-sink); nothing reachable from them imports a `node:` builtin.

### 1. Daemon identity — `@agentproto/secrets/identity`

A daemon's persistent identity, stored `~/.agentproto/identity.json` (mode
`0600`, atomic write), created lazily:

- an **X25519** keypair for key agreement (the client seals its hello to it, and
  it is one ECDH input to the session key), and
- an **Ed25519** keypair for authenticity (the daemon signs the handshake
  transcript so the client can prove it reached the daemon it scanned).

The **fingerprint** is `sha256(x25519 pub)[:16]` — the same construction as a
seal key id — and is what a human confirms at offer and accept time.

### 2. Handshake — `pair/v2` (`@agentproto/secrets/pairing`)

A minimal, Noise-flavoured, two-message handshake:

```
client → daemon:  e_pub                        // ephemeral X25519
                  ct₀ = Seal(to = daemon_x25519,
                        {clientPub: e_pub, clientName, auth})
daemon → client:  d_e_pub, sig = Ed25519(daemon_ed25519,
                        transcript = sha256(e_pub ‖ ct₀ ‖ d_e_pub))
both:             K  = HKDF-SHA256(ECDH(e, d_e) ‖ ECDH(e, daemon_x25519),
                        salt = transcript, info = "agentproto/pair/v2")
                  → K_c2d, K_d2c   (two AES-256-GCM keys)
```

- The client verifies `sig` against the Ed25519 key it learned out-of-band (the
  offer URL) → daemon authenticity, no CA.
- The daemon opens `ct₀` (only its X25519 private key can) and checks the
  sealed `auth` token in constant time → client authenticity. `auth` is never
  the value the broker saw on the upgrade URL (see below).
- Everything is transcript-bound: `sig` covers the whole transcript and the
  transcript salts the key schedule, so any tampering with `e_pub`, `ct₀`, or
  `d_e_pub` in flight makes the signature or the derived keys disagree. The
  handshake **fails closed** with a typed `PairingError`, never continuing on
  attacker-chosen material.

This module is transport-agnostic: it produces and consumes plain messages, so
the code that pumps them over a socket never touches key material beyond the two
derived session keys.

### 3. Channel — `wrapE2E` (`@agentproto/acp/tunnel`)

There is **no new wire protocol**. The existing `agentproto/tunnel/v1` frames
(`http_request`, `ws_open`, `spawn`, …) are reused verbatim; `wrapE2E` wraps a
`FrameSink` so each outgoing frame is serialized then AEAD-encrypted, and each
incoming envelope is decrypted and counter-checked before it reaches the tunnel:

```ts
wrapE2E(sink: FrameSink, keys: { sendKey, recvKey }, opts?: { aead? }): FrameSink
```

Encryption is async (WebCrypto is), but `send` stays fire-and-forget: each frame
gets its counter when `send` is called, and ciphertexts go out — and decrypted
frames come in — strictly in counter order.

It is transparent — `createTunnelClient` / `createTunnelServer` work unchanged
over a wrapped sink, so the whole daemon HTTP surface (MCP, sessions,
permissions inbox, PTY) rides a pairing with no code changes.

Nonce discipline (the security-critical part):

- Two independent keys, one per direction — a frame can never be reflected and
  decrypt.
- A per-direction, strictly-monotonic 64-bit counter is the GCM nonce (never
  random — GCM nonce reuse is catastrophic) and is also bound as AEAD associated
  data.
- The receiver requires the exact next counter. An older/repeated counter
  (**replay**), a higher one (**drop / reorder**), a flipped byte (**auth**), or
  a plaintext frame (**downgrade**) each becomes a typed `E2eError` that closes
  the channel — no tampered or out-of-order frame is ever delivered upward.
- A rekey guard errors before the counter could ever overflow (2³²); v1 has no
  ratchet, so it rekeys on reconnect rather than mid-session.

Bearer interaction is unchanged: pairing authenticates the *peer*; spawn
authorization (`authorize(spawn)`) stays a separate decision, and the pairing
layer never learns or transports the user's daemon bearer.

## What Phase 2 adds (broker, ceremony, persistence)

### The rendezvous broker — `@agentproto/rendezvous`

A deliberately dumb WebSocket server: it matches two sockets sharing a one-time
token and splices them byte-for-byte, never parsing payloads. Hygiene only —
park timeout, post-splice idle timeout, max message size, per-IP token-attempt
rate limiting, single-use tokens, constant-time token compare. Self-hostable via
[`agentproto rendezvous serve`](../verbs/rendezvous.md).

### The ceremony — [`agentproto pair`](../verbs/pair.md)

- `pair offer` (daemon) mints a single-use offer URL + QR, dials the broker
  outbound, and parks. `pair accept` (client) validates the URL, runs the client
  handshake, pins the daemon's keys, and persists the pairing.
- `pair offer --qr` shows the same offer as a phone link: the web pair page
  with the offer in its URL fragment
  (`https://cli.agentproto.sh/pair#v=2&rv=…`). A fragment never reaches a
  server. The page runs the client handshake in the browser with
  `@agentproto/pair-client` (WebCrypto, WebSocket, IndexedDB), which speaks
  the same wire protocol as `pair accept`, so the daemon can't tell the two
  apart. `parseOfferUrl` accepts both forms.
- `pair ls` lists pairings (daemon REST, or the client store when offline);
  `pair revoke` drops one so its client can no longer reconnect.
- **Revocation is announced.** Otherwise a revoked client and an offline
  daemon look the same: the client parks at the broker and gets a park
  timeout. So for a grace window (14 days) the daemon keeps a *tombstone* of
  the revoked pairing: the epoch route and auth tokens for the window only,
  not the pair root. It still parks on the routes. For a hello that carries
  that epoch's auth token, it completes the handshake, which authenticates it
  to the client. It then sends a single E2E `error{code:"pairing_revoked"}`
  and closes. A client that sees it stops retrying and asks the user to pair
  again. A live channel gets the same frame at revoke time.
  - The broker learns nothing new: it sees the same parking and a short splice.
  - It can't forge the signal, which is authenticated like every tunnel frame.
  - It can't elicit the signal either: a route is never accepted as proof.
  - A revoked legacy (`pair/v1`) pairing gets no tombstone; its client can
    only be told to re-pair.
- `pair exec <name> -- <verb>` routes any verb over the pairing (the P2 client
  routing seam — a loopback bridge that a child `agentproto <verb>` drives via
  `AGENTPROTO_DAEMON_URL`).

MCP tools mirror the daemon-side verbs: `pair_offer`, `pair_list`, `pair_revoke`.
REST routes: `POST /pairings/offer`, `GET /pairings`, `DELETE /pairings/:fp`.

### Persistence, reconnect epochs, autoconnect

- Daemon pairings live in `~/.agentproto/pairings.json` (`0600`); the client
  half (pinned daemon keys + the `pairRoot` secret) in
  `~/.agentproto/pair-credentials.json` (`0600`). A browser client keeps the
  same record in IndexedDB, with the pair root imported as a non-extractable
  WebCrypto HKDF key. It never uses localStorage.
- After the first pairing there is no live offer, so reconnects use
  **pairing-derived epoch tokens** (epoch = UTC day number): the client dials
  the epoch **route** and proves the epoch **auth** inside the sealed hello (see
  [Route and auth tokens](#route-and-auth-tokens)). Both sides derive them; the
  daemon accepts the current and previous epoch to bridge clock skew, and
  rotating them per day keeps the broker from linking sessions across days.
- A pairing made under the retired `pair/v1` protocol can't reconnect — see
  [Protocol v2 and re-pairing](#protocol-v2-and-re-pairing).
- With `pairing.autoconnect` on (default when a rendezvous is set), the daemon
  opens a standing rendezvous connection for every persisted pairing on boot —
  the same pattern as `tunnel.autoconnect` — so a paired client can reconnect
  anytime. Config keys: `pairing.rendezvous`, `pairing.autoconnect` (see
  [config-schema.md](../reference/config-schema.md)).

### Route and auth tokens

Every pairing secret is split into two HKDF-SHA256 outputs with distinct labels.
The **route** is the only value that ever goes on a broker upgrade URL
(`?side=…&t=<route>`); the **auth** token travels only inside the sealed hello,
which only the daemon's X25519 key can open, and the daemon compares it in
constant time. HKDF is one-way, so knowing a route — which the broker always
does — doesn't give you its auth token.

| Token | IKM | salt | info | Bytes |
| --- | --- | --- | --- | --- |
| offer route | offer secret (URL `s`, UTF-8) | `agentproto/pair-offer` | `agentproto/rv-route` | 16 (22 b64url chars) |
| offer auth | offer secret (URL `s`, UTF-8) | `agentproto/pair-offer` | `agentproto/rv-auth` | 32 |
| epoch route | `pairRoot` | `agentproto/rv-route-salt` | `agentproto/rv-route` ‖ u64be(epoch) | 16 (22 b64url chars) |
| epoch auth | `pairRoot` | `agentproto/rv-auth-salt` | `agentproto/rv-auth` ‖ u64be(epoch) | 32 |

- **Offer:** the daemon parks on the offer route and the client dials it; the
  hello carries the offer auth. The offer stays single-use and is spent only by
  a hello with the correct auth — a wrong one spends nothing, so the legitimate
  client can still pair until the offer expires.
- **Reconnect:** the daemon parks on the current and previous epoch routes; the
  hello carries that epoch's auth.
- **What the broker learns:** route tokens only. They are opaque (a random-
  looking 22-char string), rotate daily for reconnects, and authenticate
  nothing — the broker can meet a daemon on one, but it can't get past the
  handshake. The offer secret and every auth token never touch the broker.

### Protocol v2 and re-pairing

`pair/v1` used one token for both jobs: the offer token (and, on reconnect, the
epoch token) was both the broker route and the proof inside the sealed hello.
A broker — or anyone logging its upgrade URLs — could therefore connect to the
route as a client, seal a hello to the daemon's public key carrying the route
it had just seen, and pair (first contact) or be served a full channel
(reconnect replay). `pair/v2` fixes this with the route/auth split above.

There is no compatibility window, and v1 pairings aren't upgraded in place
(under v1 any stored pairing might be the broker's own). Re-pair once: run
`agentproto pair offer` on the daemon and `agentproto pair accept` on the
client, then `agentproto pair revoke <name>` the old entry. Mismatches fail
with that instruction, not a timeout:

- A v1 offer URL (`v=1`) is refused by a v2 client (`pairing_protocol_outdated`);
  a v1 client refuses a v2 URL (`unsupported offer version "2"` — upgrade it).
- A v1 `pairings.json` / `pair-credentials.json` loads with every entry flagged
  **legacy**: `pair ls` marks them, the daemon logs them, and they are never
  served or dialed.
- An un-upgraded v1 client that reconnects to a v2 daemon still meets it (the
  epoch route is unchanged from v1). The daemon completes that client's v1
  handshake only to send the re-pair notice inside the encrypted channel, then
  closes. It checks no token and serves nothing.
- A v2 client whose daemon hangs up on its hello (a v1 daemon) gets an error
  that names the likely cause and the fix.

## The hosted default

`pair offer` needs a meeting point. So that it works out of the box, the daemon
defaults to a hosted broker when none is configured:

**Precedence:** `--rendezvous` flag → `pairing.rendezvous` in `config.json` →
the hosted default `wss://rdv.agentproto.sh/v1`.

What the hosted broker can see is exactly what any rendezvous can see, and no
more: it splices two sockets by route token and relays **ciphertext**
byte-for-byte. It learns the route tokens, the peers' IPs, ciphertext sizes, and
timing — never plaintext, never an auth token — and it cannot pair, inject,
alter, or replay frames (the `pair/v2` handshake is transcript-bound and every frame is AEAD-sealed with a
monotonic nonce; see [Threat model](#threat-model)). This is the same guarantee
as a self-hosted broker; the only thing that changes by default is *who runs
the box*.

Because that is a trust decision, it is never silent: `pair offer` names the
broker it used and flags the hosted default (the REST/MCP surfaces carry a
`rendezvousIsHostedDefault` field).

**Pointing elsewhere.** Self-host the broker with
[`agentproto rendezvous serve`](../verbs/rendezvous.md) and set
`pairing.rendezvous` in `config.json` (or pass `--rendezvous` per offer). To
disable the default entirely — a daemon that must never reach the hosted broker
unless an endpoint is named explicitly — set `pairing.rendezvous: ""`; `pair
offer` then requires an explicit `--rendezvous`.

## Status

- **Phase 1:** identity module, `pair/v1` handshake, `wrapE2E` channel, and the
  adversarial test suite (tampered-broker vectors: flip / drop / reorder /
  replay / downgrade). Proven end-to-end over an in-process socket pair.
- **Phase 2:** the `@agentproto/rendezvous` broker package, the `pair`
  CLI/MCP verbs (`offer` / `accept` / `ls` / `revoke` / `exec`), pairing
  persistence, reconnect epochs, and autoconnect on boot.
- **Phase 3 (in progress):** the hosted broker is deployed and is now the
  default meeting point for `pair offer` (see [The hosted
  default](#the-hosted-default)). Still to come: the mobile deep-link page and
  the pairing spec, AIP-59 (draft, agentproto/agentproto#41).
