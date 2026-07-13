# Pairing (end-to-end, over an untrusted rendezvous)

**Pairing** is a persistent, end-to-end-encrypted relationship between a
*client* (the CLI today; mobile/web later) and a *daemon* (`agentproto serve`).
Its goal is to let a client reach a daemon that only ever dials **outbound**,
through a broker that **cannot read or forge the traffic** — bootstrapped by a
single offer URL / QR code, with no accounts, no DNS, no inbound ports, and no
trusted middlebox.

This page describes what exists **after Phase 1**: the cryptographic library
layer. The `pair` CLI verbs, the rendezvous broker, and on-disk persistence of
pairings land in Phase 2 — see *Status* at the bottom.

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

## Status

- **Phase 1 (this):** identity module, `pair/v1` handshake, `wrapE2E` channel,
  and the adversarial test suite (tampered-broker vectors: flip / drop / reorder
  / replay / downgrade). Proven end-to-end over an in-process socket pair — no
  broker yet.
- **Phase 2:** the `@agentproto/rendezvous` broker package, the `pair`
  CLI/MCP verbs (`offer` / `accept` / `ls` / `revoke`), pairing persistence,
  reconnect epochs, and autoconnect on boot.
- **Phase 3:** hosted broker deploy, mobile deep-link page, and the AIP-53
  `PAIRING.md` spec.
