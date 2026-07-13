# `agentproto pair`

```text
agentproto pair offer  [--ttl 10m] [--rendezvous <wss://…>] [--no-qr] [--json]
agentproto pair accept "<offer-url>" [--name <label>]
agentproto pair ls     [--json]
agentproto pair revoke <fingerprint|name>
agentproto pair exec   <fingerprint|name> -- <verb> [args…]
```

End-to-end-encrypted pairing between a **client** (this CLI) and a **daemon**
(`agentproto serve`), over an untrusted [rendezvous broker](./rendezvous.md).
The broker splices two sockets and relays ciphertext byte-for-byte — it never
sees plaintext and cannot forge frames. See
[concepts/pairing.md](../concepts/pairing.md) for the crypto and threat model.

The bootstrap secret is a single **offer URL** (optionally a QR code): it
carries the daemon's public keys (so a malicious broker can't MITM) and a
short-lived, single-use token (so strangers can't pair).

## `offer` — daemon side

Mint a one-time offer and start listening on the rendezvous. Run on the machine
with the daemon (round-trips the daemon's `POST /pairings/offer` route, so a
daemon must be reachable — see [sessions.md](./sessions.md#discovery) for how
the daemon is discovered).

```bash
agentproto pair offer --ttl 10m --rendezvous wss://rendezvous.example/v1
```

```text
Pairing offer (daemon a1b2c3d4e5f60718) — expires 2026-07-13T19:20:00.000Z

  agentproto://pair?v=1&rv=…&id=a1b2c3d4e5f60718&pk=…&sk=…&t=…&exp=…

  █▀▀▀▀▀█ ▀▀ █ █▀▀▀▀▀█        (QR of the URL — omit with --no-qr)
  …

On the other machine:
  agentproto pair accept "agentproto://pair?v=1&…"

The daemon is now listening on wss://rendezvous.example/v1. This window can close.
```

- `--ttl` accepts `10m`, `30s`, `2h`, or a bare number of minutes (default 10m).
- `--rendezvous` overrides `pairing.rendezvous` from config for this offer.
- `--no-qr` prints the URL only (also the fallback when the optional
  `qrcode-terminal` renderer isn't installed).
- `--json` emits `{ url, fingerprint, rendezvous, expiresAt }` for scripting.

The daemon dials the broker outbound and parks until the client arrives, then
runs the `pair/v1` handshake and persists the pairing to
`~/.agentproto/pairings.json` (mode `0600`).

## `accept` — client side

Parse and validate an offer URL, dial the broker, run the client handshake,
verify the daemon's transcript signature against the key in the URL, confirm the
derived fingerprint matches the URL's `id`, and persist the pairing to
`~/.agentproto/pair-credentials.json` (mode `0600`).

```bash
agentproto pair accept "agentproto://pair?v=1&…" --name my-laptop
```

```text
✓ Paired with daemon a1b2c3d4e5f60718
  name:       my-laptop
  rendezvous: wss://rendezvous.example/v1

Confirm this fingerprint matches what the daemon showed at `pair offer`.
Run a verb over the pairing with:
  agentproto pair exec my-laptop -- sessions ls
```

`--name` labels the pairing locally (also sent as the client name the daemon
records); it defaults to `<user>@<host>`. **Confirm the fingerprint** against
what the daemon printed — that is the human check that defeats a swapped QR.

## `ls` — both sides

List pairings. When a daemon is reachable it lists the daemon's pairings (via
`GET /pairings`); otherwise it lists this machine's client-side pairings from
`pair-credentials.json`.

```bash
agentproto pair ls
agentproto pair ls --json
```

## `revoke` — daemon side

Drop a pairing by fingerprint or name so its client can no longer reconnect —
the daemon stops parking on the pairing's routing tokens and refuses future
hellos from that client. Also drops the local client-side record if it lives on
this machine. With no daemon reachable, only the client-side record is removed
(and a note says so).

```bash
agentproto pair revoke my-laptop
```

## `exec` — client routing

Run any `agentproto` verb against a paired daemon over the E2E channel. This is
the P2 routing surface (a full `agentproto --host pair:<fingerprint> <verb>`
lands later — see *Client routing* below).

```bash
agentproto pair exec my-laptop -- sessions ls
agentproto pair exec my-laptop -- mcp-bridge --list
```

`exec` reconnects the pairing using the current epoch routing token (falling
back to the previous epoch to bridge clock skew), stands up a throwaway
loopback HTTP bridge that forwards every request over the pairing, and spawns
`agentproto <verb>` with `AGENTPROTO_DAEMON_URL` pointed at the bridge — so the
child discovers and drives the paired daemon transparently, and the whole daemon
HTTP surface (MCP, sessions, permissions, PTY) works unchanged.

## Client routing (the seam)

P2 ships `pair exec <fingerprint> -- <verb>` rather than a generic
`agentproto --host pair:<fingerprint> <verb>`. The offer/design mentions the
latter; the former is the smallest viable seam — it routes every verb over a
pairing without threading an E2E transport through each command's HTTP helpers,
by relying on the fact that every verb already discovers its daemon purely from
`AGENTPROTO_DAEMON_URL`. The generic `--host pair:` prefix can be layered on top
of the same bridge later without changing the transport.

## Files

| Path | Side | Contents |
| --- | --- | --- |
| `~/.agentproto/identity.json` | daemon | daemon X25519 + Ed25519 keys (`0600`, created lazily on first `offer`) |
| `~/.agentproto/pairings.json` | daemon | persisted client pairings (`0600`) |
| `~/.agentproto/pair-credentials.json` | client | pinned daemon keys + `pairRoot` per pairing (`0600`) |

Config keys (`~/.agentproto/config.json`): `pairing.rendezvous`,
`pairing.autoconnect` — see [config-schema.md](../reference/config-schema.md).

## See also

- [rendezvous.md](./rendezvous.md) — self-host the broker.
- [concepts/pairing.md](../concepts/pairing.md) — crypto, handshake, threat model.
- [serve.md](./serve.md) — the daemon side.
