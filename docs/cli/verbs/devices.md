# `agentproto devices`

```text
agentproto devices list   [--json]
agentproto devices rename <fingerprint|name> <new-name>
agentproto devices revoke <fingerprint|name>
agentproto devices add    <offer-url> [--name <label>]
agentproto devices status <fingerprint|name>
```

The device registry: a management view over every client paired with this
daemon ([`agentproto pair`](./pair.md)) and every host this daemon has
registered via reverse pairing (`add`, below). Client devices come from the
same underlying registry as `pair ls` / `pair revoke`; `devices` adds `role`,
`kind`, `online`, and (for a host-scoped pairing/host) `scope`, plus the
ability to rename a device.

All subcommands round-trip the daemon's `/devices` REST routes (the same
surface the MCP `device_list` / `device_rename` / `device_revoke` /
`device_add` tools drive) — a daemon must be reachable (see
[sessions.md](./sessions.md#discovery) for how it's discovered).

## `list`

```bash
agentproto devices list
```

```text
NAME                  FINGERPRINT                      ROLE    KIND      ONLINE  LAST SEEN               RENDEZVOUS
jeremy@laptop         a1b2c3d4e5f607189c3e5d7f1a2b4c6d  client  cli       yes     2026-09-27T12:00:00.000Z  wss://rdv.agentproto.sh/v1
browser@iphone.local  b2c3d4e5f607189c3e5d7f1a2b4c6d0a  client  browser   no      2026-09-20T08:30:00.000Z  wss://rdv.agentproto.sh/v1
```

- `role` is `client` (paired via `pair accept`) or `host` (registered via
  `devices add`).
- `kind` (`browser` | `cli` | `daemon`) is a best-effort guess from the
  device's self-reported name — pair/v2's handshake carries no dedicated
  client-kind field yet, but both shipped clients default that name to a
  recognisable shape (`browser@<host>` for the web pair page,
  `<user>@<host>` for the CLI). A custom `--name` at `pair accept` overrides
  the default and loses the signal.
- `online` reflects whether a channel (an offer or a standing reconnect) is
  served for that device *right now* (client) or a `devices status`/`exec`
  call is in flight for it *right now* (host) — it is not persisted, and
  always starts `false` on a fresh daemon boot until a client reconnects or a
  host is probed. A host has no standing connection, so unlike a client its
  `online` is not a live heartbeat — see [below](#add).
- `scope: host` marks a pairing/host granted under an offer minted with
  `agentproto pair offer --host` — visible from either side of that pairing.
- `--json` emits `{ devices: [...] }` with the same fields.

## `rename`

```bash
agentproto devices rename jeremy@laptop "jeremy's MacBook"
```

Cosmetic only — renaming a device has no effect on pairing, auth, or
routing. Matches by fingerprint or current name; exits 2 if nothing matches.

## `revoke`

```bash
agentproto devices revoke jeremy@laptop
```

Same daemon-side effect as [`pair revoke`](./pair.md#revoke--daemon-side):
drops the device's rendezvous connections so it can no longer reconnect. Use
whichever verb reads more naturally — they call the same registry.

## `add`

```bash
agentproto devices add "agentproto://pair?v=2&…&scope=host" --name my-host
```

Register another daemon as a driveable **host** (reverse pairing) from an
offer minted on it with [`pair offer --host`](./pair.md#offer--daemon-side).
Runs the pair/v2 client handshake (the same crypto `pair accept` runs),
verifies the daemon fingerprint, and persists the pair root to
`~/.agentproto/hosts.json`. **Refuses — no dial attempted — an offer that
isn't host-scoped**: an ordinary `pair offer` (no `--host`) only grants
remote-control access, not host registration, even though the wire
capability is identical either way. See
[pair.md](./pair.md#offer--daemon-side) for what host control actually
grants.

The registered host then shows up in `devices list` with `role: host`,
`kind: daemon`, `scope: host`.

## `status`

```bash
agentproto devices status my-host
```

Probes a registered host's `/health` over its E2E channel — a fresh dial +
handshake each call (a host has no standing connection, unlike a paired
client). Confirms the host is reachable and this daemon can still drive it.
Exits non-zero on an unreachable host or a non-2xx response.

## See also

- [pair.md](./pair.md) — pairing itself (`offer` / `accept` / `exec`), and
  the crypto behind `online`'s "channel up/closed" state.
- [doctor.md](./doctor.md) — the `Devices` check flags any device never
  seen, or not seen in 30+ days.
