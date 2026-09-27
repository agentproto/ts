# `agentproto devices`

```text
agentproto devices list   [--json]
agentproto devices rename <fingerprint|name> <new-name>
agentproto devices revoke <fingerprint|name>
```

The device registry: a management view over every client paired with this
daemon (today, everything [`agentproto pair`](./pair.md) knows about — a
reverse-paired *host* joins the same list in a later release). Same
underlying registry as `pair ls` / `pair revoke`; `devices` adds `role`,
`kind`, and `online`, plus the ability to rename a device.

All three subcommands round-trip the daemon's `/devices` REST routes (the
same surface the MCP `device_list` / `device_rename` / `device_revoke` tools
drive) — a daemon must be reachable (see
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

- `role` is `client` or `host`; only `client` exists today.
- `kind` (`browser` | `cli` | `daemon`) is a best-effort guess from the
  device's self-reported name — pair/v2's handshake carries no dedicated
  client-kind field yet, but both shipped clients default that name to a
  recognisable shape (`browser@<host>` for the web pair page,
  `<user>@<host>` for the CLI). A custom `--name` at `pair accept` overrides
  the default and loses the signal.
- `online` reflects whether a channel (an offer or a standing reconnect) is
  served for that device *right now* — it is not persisted, and always
  starts `false` on a fresh daemon boot until a client reconnects.
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

## See also

- [pair.md](./pair.md) — pairing itself (`offer` / `accept` / `exec`), and
  the crypto behind `online`'s "channel up/closed" state.
- [doctor.md](./doctor.md) — the `Devices` check flags any device never
  seen, or not seen in 30+ days.
