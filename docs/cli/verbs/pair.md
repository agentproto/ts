# `agentproto pair`

```text
agentproto pair offer  [--ttl 10m] [--rendezvous <wss://…>] [--no-qr | --qr [--pair-page <url|template>]] [--json]
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
short-lived, single-use secret (so strangers can't pair). The secret never goes
on the wire: both sides derive from it a route the broker sees and a separate
auth token that travels only inside the encrypted hello, so the broker can't
pair either.

## `offer` — daemon side

Mint a one-time offer and start listening on the rendezvous. Run on the machine
with the daemon (round-trips the daemon's `POST /pairings/offer` route, so a
daemon must be reachable — see [sessions.md](./sessions.md#discovery) for how
the daemon is discovered).

Works with no config: when neither `--rendezvous` nor `pairing.rendezvous` is
set, the offer routes through the **hosted broker**
`wss://rdv.agentproto.sh/v1`. The broker only ever relays ciphertext — the
route token (opaque, non-authenticating), peer IPs, ciphertext sizes, and
timing, never your traffic (see
[concepts/pairing.md](../concepts/pairing.md#threat-model)). `pair offer` names
the broker it used and flags the hosted default, so a daemon never relays
through it silently.

```bash
agentproto pair offer
```

```text
Pairing offer (daemon a1b2c3d4e5f60718) — expires 2026-07-13T19:20:00.000Z

  agentproto://pair?v=2&rv=…&id=a1b2c3d4e5f60718&pk=…&sk=…&s=…&exp=…

  █▀▀▀▀▀█ ▀▀ █ █▀▀▀▀▀█        (QR of the URL — omit with --no-qr)
  …

On the other machine:
  agentproto pair accept "agentproto://pair?v=2&…"

The daemon is now relaying through wss://rdv.agentproto.sh/v1
  (hosted default — the broker sees only ciphertext, never your traffic.
   Self-host with `agentproto rendezvous serve` and set pairing.rendezvous,
   or pass --rendezvous, to route elsewhere.)
This window can close.
```

- `--ttl` accepts `10m`, `30s`, `2h`, or a bare number of minutes (default 10m).
- `--rendezvous` overrides `pairing.rendezvous` (and the hosted default) for
  this offer.
- `--no-qr` prints the URL only (also the fallback when the optional
  `qrcode-terminal` renderer isn't installed).
- `--qr` pairs a **phone browser** instead of another CLI: it prints, and draws
  as the QR, the web pair page with the offer in its fragment —
  `https://cli.agentproto.sh/pair#v=2&rv=…&id=…&pk=…&sk=…&s=…&exp=…` (the query
  string of the `agentproto://` URL, verbatim, after the `#`). A URL fragment
  is never sent to a server, so the page's host never sees the token. The page
  runs the same handshake in the browser (`@agentproto/pair-client`) and shows
  the daemon's name and fingerprint to confirm. The `agentproto://` URL is still
  printed for `pair accept`, and either form is accepted by both clients.
- `--pair-page <url|template>` (with `--qr`) picks the pair page for this
  offer. It overrides `pairing.pairPage` in config, and the default is
  `https://cli.agentproto.sh/pair`. It accepts two forms:
  - A **plain URL**, used as is, e.g. a local `http://localhost:3000/pair`.
  - A **template** with `{fp}` in the **hostname**, filled with the daemon's
    identity fingerprint (lowercase hex):

    ```bash
    agentproto pair offer --qr --pair-page 'https://{fp}.agentproto.cloud/pair'
    # → https://a1b2c3d4e5f60718.agentproto.cloud/pair#v=2&…
    ```

    That gives each daemon its own browser origin (see
    [concepts/pairing.md](../concepts/pairing.md#the-phone-pair-page-one-origin-per-daemon)).
    `{fp}` anywhere else (path, query, port, userinfo) is rejected, as is any
    other `{…}`. The page setting is checked before the offer is minted.
- `--json` emits `{ url, fingerprint, rendezvous, rendezvousIsHostedDefault,
  expiresAt }` for scripting, plus `webUrl` (the resolved pair-page link) with
  `--qr`.

```bash
agentproto pair offer --qr
```

```text
Pairing offer (daemon a1b2c3d4e5f60718) — expires 2026-07-13T19:20:00.000Z

  agentproto://pair?v=2&rv=…&id=a1b2c3d4e5f60718&pk=…&sk=…&s=…&exp=…

Scan with a phone (opens the pair page in the browser):

  https://cli.agentproto.sh/pair#v=2&rv=…&id=a1b2c3d4e5f60718&pk=…&sk=…&s=…&exp=…

  █▀▀▀▀▀█ ▀▀ █ █▀▀▀▀▀█        (QR of the pair-page link)
  …

Confirm the page shows daemon a1b2c3d4e5f60718 before you accept.

**Routing precedence:** `--rendezvous` → `pairing.rendezvous` in config → the
hosted default. To point elsewhere, self-host the broker
([`rendezvous serve`](./rendezvous.md)) and set `pairing.rendezvous`. To disable
the default entirely — so the daemon never reaches the hosted broker unless an
endpoint is named — set `pairing.rendezvous: ""` in config; `pair offer` then
requires an explicit `--rendezvous`.

The daemon dials the broker outbound and parks until the client arrives, then
runs the `pair/v2` handshake and persists the pairing to
`~/.agentproto/pairings.json` (mode `0600`).

## `accept` — client side

Parse and validate an offer URL, dial the broker, run the client handshake,
verify the daemon's transcript signature against the key in the URL, confirm the
derived fingerprint matches the URL's `id`, and persist the pairing to
`~/.agentproto/pair-credentials.json` (mode `0600`).

```bash
agentproto pair accept "agentproto://pair?v=2&…" --name my-laptop
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

Pairings made under the retired `pair/v1` protocol are listed with
`[legacy: re-pair]` (`"legacy": true` in `--json`). They can't connect: re-pair
with `pair offer` / `pair accept`, then `pair revoke` the legacy entry (see
[concepts/pairing.md](../concepts/pairing.md#protocol-v2-and-re-pairing)).

## `revoke` — daemon side

Drop a pairing by fingerprint or name so its client can no longer reconnect.
A live channel for it is closed. Also drops the local client-side record if it
lives on this machine. With no daemon reachable, only the client-side record is
removed (and a note says so).

For 14 days after the revoke, the daemon keeps parking on the pairing's route
tokens. A client that proves that day's **auth** token in its sealed hello
completes the handshake, which proves to it that this is the real daemon. It
then gets one encrypted `pairing_revoked` frame, and the channel closes; it is
never served. So a revoked browser client stops with "this device was unpaired
from <daemon>; scan a new pairing QR" instead of retrying as if the daemon were
offline. The broker can't forge that signal, since it travels inside the E2E
channel. The broker can't trigger it either: it knows the routes, but a route is
never accepted as proof. For that window the daemon keeps only the route and
auth tokens, never the pair root. A revoked legacy (`pair/v1`) pairing gets no
such window: its client can only be told to re-pair.

```bash
agentproto pair revoke my-laptop
```

## `exec` — client routing

Run any `agentproto` verb against a paired daemon over the E2E channel. This is
the P2 routing surface (a full `agentproto --host pair:<fingerprint> <verb>`
lands later — see *Client routing* below).

```bash
agentproto pair exec my-laptop -- sessions ls
agentproto pair exec my-laptop -- permissions ls
```

`exec` reconnects the pairing on the current epoch route, proving that epoch's
sealed auth token (falling back to the previous epoch to bridge clock skew). A
legacy (`pair/v1`) pairing is refused up front with the re-pair instruction.
It then stands up a throwaway
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
| `~/.agentproto/pairings.json` | daemon | persisted client pairings, plus `revoked` tombstones (routing tokens only) for the post-revoke window (`0600`) |
| `~/.agentproto/pair-credentials.json` | client | pinned daemon keys + `pairRoot` per pairing (`0600`) |

Config keys (`~/.agentproto/config.json`): `pairing.rendezvous`,
`pairing.autoconnect` — see [config-schema.md](../reference/config-schema.md).

## See also

- [rendezvous.md](./rendezvous.md) — self-host the broker.
- [concepts/pairing.md](../concepts/pairing.md) — crypto, handshake, threat model.
- [serve.md](./serve.md) — the daemon side.
