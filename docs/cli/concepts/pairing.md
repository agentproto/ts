# Pairing (end-to-end, over an untrusted rendezvous)

**Pairing** is a persistent, end-to-end-encrypted relationship between a
*client* (the CLI today; mobile/web later) and a *daemon* (`agentproto serve`).
Its goal is to let a client reach a daemon that only ever dials **outbound**,
through a broker that **cannot read or forge the traffic** — bootstrapped by a
single offer URL / QR code, with no accounts, no DNS, no inbound ports, and no
trusted middlebox.

This page describes what exists **after Phase 2**: the cryptographic library
layer (Phase 1), plus the rendezvous broker, the `pair` CLI/MCP verbs, on-disk
persistence, reconnect epochs, and autoconnect on boot. The hosted broker, the
mobile deep-link page, and the AIP-53 spec remain Phase 3 — see *Status* at the
bottom.

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
ciphertext byte-for-byte. It learns the routing token, the peers' IPs, timing,
and ciphertext sizes — never the content, and it cannot inject or alter frames.

## Threat model

| Adversary | Capability | Mitigation |
| --- | --- | --- |
| Rendezvous operator | read / modify / replay bytes | E2E AEAD + transcript-bound signature; sees only sizes + timing |
| Offer-URL thief (pre-expiry) | pair as a new client | short TTL + single-use token; daemon shows name + fingerprint on accept; `pair revoke` |
| Evil "daemon" (wrong QR) | impersonate the daemon | fingerprint shown at offer and accept; keys pinned after first pair |
| Stolen client credstore | act as that client | per-client revocation; `pairings.json` audit (`lastSeen`) |
| Broker DoS | drop / delay traffic | reconnect-with-backoff; self-host escape hatch |

Out of scope for v1: post-compromise security (no ratchet — rekey on reconnect
only), multi-device sync, and broker federation.

## What Phase 1 ships (the library layer)

Three pieces, all built on `node:crypto` (X25519, Ed25519, HKDF-SHA256,
AES-256-GCM) with zero native dependencies:

### 1. Daemon identity — `@agentproto/secrets/identity`

A daemon's persistent identity, stored `~/.agentproto/identity.json` (mode
`0600`, atomic write), created lazily:

- an **X25519** keypair for key agreement (the client seals its hello to it, and
  it is one ECDH input to the session key), and
- an **Ed25519** keypair for authenticity (the daemon signs the handshake
  transcript so the client can prove it reached the daemon it scanned).

The **fingerprint** is `sha256(x25519 pub)[:16]` — the same construction as a
seal key id — and is what a human confirms at offer and accept time.

### 2. Handshake — `pair/v1` (`@agentproto/secrets/pairing`)

A minimal, Noise-flavoured, two-message handshake:

```
client → daemon:  e_pub                        // ephemeral X25519
                  ct₀ = Seal(to = daemon_x25519,
                        {clientPub: e_pub, clientName, offerToken})
daemon → client:  d_e_pub, sig = Ed25519(daemon_ed25519,
                        transcript = sha256(e_pub ‖ ct₀ ‖ d_e_pub))
both:             K  = HKDF-SHA256(ECDH(e, d_e) ‖ ECDH(e, daemon_x25519),
                        salt = transcript, info = "agentproto/pair/v1")
                  → K_c2d, K_d2c   (two AES-256-GCM keys)
```

- The client verifies `sig` against the Ed25519 key it learned out-of-band (the
  offer URL) → daemon authenticity, no CA.
- The daemon opens `ct₀` (only its X25519 private key can) and checks the
  one-time `offerToken` → client authenticity.
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
wrapE2E(sink: FrameSink, keys: { sendKey, recvKey }): FrameSink
```

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
- `pair ls` lists pairings (daemon REST, or the client store when offline);
  `pair revoke` drops one so its client can no longer reconnect.
- `pair exec <name> -- <verb>` routes any verb over the pairing (the P2 client
  routing seam — a loopback bridge that a child `agentproto <verb>` drives via
  `AGENTPROTO_DAEMON_URL`).

MCP tools mirror the daemon-side verbs: `pair_offer`, `pair_list`, `pair_revoke`.
REST routes: `POST /pairings/offer`, `GET /pairings`, `DELETE /pairings/:fp`.

### Persistence, reconnect epochs, autoconnect

- Daemon pairings live in `~/.agentproto/pairings.json` (`0600`); the client
  half (pinned daemon keys + the `pairRoot` secret) in
  `~/.agentproto/pair-credentials.json` (`0600`).
- After the first pairing there is no live offer, so reconnects route on a
  **pairing-derived epoch token** `t' = HKDF(pairRoot, "rv-route" ‖ epoch)`
  (epoch = UTC day number). Both sides derive it; the daemon accepts the current
  and previous epoch to bridge clock skew, and rotating it per day keeps the
  broker from linking sessions across days.
- With `pairing.autoconnect` on (default when a rendezvous is set), the daemon
  opens a standing rendezvous connection for every persisted pairing on boot —
  the same pattern as `tunnel.autoconnect` — so a paired client can reconnect
  anytime. Config keys: `pairing.rendezvous`, `pairing.autoconnect` (see
  [config-schema.md](../reference/config-schema.md)).

## Status

- **Phase 1:** identity module, `pair/v1` handshake, `wrapE2E` channel, and the
  adversarial test suite (tampered-broker vectors: flip / drop / reorder /
  replay / downgrade). Proven end-to-end over an in-process socket pair.
- **Phase 2 (this):** the `@agentproto/rendezvous` broker package, the `pair`
  CLI/MCP verbs (`offer` / `accept` / `ls` / `revoke` / `exec`), pairing
  persistence, reconnect epochs, and autoconnect on boot.
- **Phase 3:** hosted broker deploy, mobile deep-link page, and the AIP-53
  `PAIRING.md` spec.
