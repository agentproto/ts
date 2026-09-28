# `agentproto devices`

```text
agentproto devices list   [--json]
agentproto devices rename <fingerprint|name> <new-name>
agentproto devices revoke <fingerprint|name>
agentproto devices add    <offer-url> [--name <label>]
agentproto devices status <fingerprint|name>
agentproto devices share-inference on|off
agentproto devices sessions <fingerprint|name> [--session <id>] [--lines <n>] [--clean] [--json]
agentproto devices join-token create <name> [--ttl <duration>] [--max-uses <n>]
agentproto devices join-token list   [--json]
agentproto devices join-token revoke <id|name>
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

## `share-inference`

```bash
agentproto devices share-inference on
agentproto devices share-inference off
```

Opt THIS daemon in (or out) of exposing its own local inference endpoint(s)
— the `llmEndpoint` sidecar's `GET /v1/models` and `POST
/v1/chat/completions` — to a paired controller. Writes
`features.deviceInferenceShare` to `config.json`; restart `agentproto serve`
(or the daemon) for a change to take effect.

**Two independent gates, both required**, from either side:

- On THIS machine (B): `deviceInferenceShare` on (this command) AND
  `features.llmEndpoint` on (`agentproto llm gateway status`; it defaults on
  once a named endpoint is configured).
- On the pairing itself: the OTHER daemon (A) must have registered this one
  as a **host** — `agentproto pair offer --host` here, `agentproto devices
  add` there. An ordinary remote-control pairing never gets these routes,
  whatever `share-inference` is set to — see
  [pair.md](./pair.md#offer--daemon-side).

Once both are on, A addresses this daemon's endpoints transparently as
`<endpointId>@<device>` — e.g. a model string `ollama@my-host/llama3.1:8b`
routed through A's own llm-endpoint gateway forwards to B's `ollama`
endpoint, over the paired E2E channel, with no open inbound port on B.
Offline/unreachable surfaces as a normal upstream error, not a hang.

## `sessions`

```bash
agentproto devices sessions my-host
agentproto devices sessions my-host --session <sessionId> [--lines 100] [--clean] [--json]
```

Read-only access to a registered host's own session list (or, with
`--session`, a tail of one session's output) — forwarded live over the host's
E2E channel.

| Flag | Description |
|------|-------------|
| `--session <id>` | Fetch one session's output instead of the session list. |
| `--lines <n>` | When fetching output, return the last N lines (default: provider decided). |
| `--clean` | Strip ANSI codes from output lines. |
| `--json` | Emit raw JSON from the daemon's response. |

Without `--session`, prints the host's session list as JSON. Exits non-zero if
the host is unreachable.

## `join-token`

```bash
agentproto devices join-token create <name> [--ttl <duration>] [--max-uses <n>]
agentproto devices join-token list   [--json]
agentproto devices join-token revoke <id|name>
```

Manage **AGENTPROTO_JOIN credentials** — long-lived, revocable, reusable
tokens a box daemon reads from its `AGENTPROTO_JOIN` env var at boot to
auto-register itself as a host on this daemon. No offer URL to relay by hand.

### `join-token create`

Mints a new join token and prints it **once** — it is never shown again by
`list`. Set it as the box daemon's `AGENTPROTO_JOIN` env var (e.g. a GitHub
Actions secret or a Kubernetes secret).

| Flag | Default | Description |
|------|---------|-------------|
| `--ttl <duration>` | `90d` | Lifetime of the token — `90d`, `24h`, `30m`, `45s`, etc. |
| `--max-uses <n>` | unlimited | Reuse ceiling; revoked automatically once reached. |

### `join-token list`

Lists all tokens for this daemon: id, name, createdAt, expiresAt, use count,
last used, and revocation status. Never shows the token secret itself.
`--json` emits `{ tokens: [...] }`.

### `join-token revoke`

Stops a token's standing accept loop. A box that already joined through it
keeps its host registration — use `agentproto devices revoke <device>` to
drop the registered device separately if needed.

A box daemon started with a valid `AGENTPROTO_JOIN` URL dials in at boot and
this daemon adds it to its host registry automatically (same effect as
running `agentproto devices add` by hand, but fully automated). See also the
`AGENTPROTO_JOIN` boot-time handling in [`serve.md`](./serve.md#agentproto_join).

## See also

- [pair.md](./pair.md) — pairing itself (`offer` / `accept` / `exec`), and
  the crypto behind `online`'s "channel up/closed" state.
- [doctor.md](./doctor.md) — the `Devices` check flags any device never
  seen, or not seen in 30+ days.
