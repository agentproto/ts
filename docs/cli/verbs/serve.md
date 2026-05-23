# `agentproto serve`

```text
agentproto serve [--workspace <dir>] [--port <n>] [--bind <ip>]
                 [--connect <url> [--token <jwt>] [--label <name>]]
                 [--allow-origin <url> …] [--interactive | -i]
```

Runs the agentproto daemon in the foreground. Boots a local HTTP
gateway (sessions, MCP, events SSE, optional PTY WS) on `--port`
(default `18790`) and, if `--connect <url>` is set, opens an
outbound WebSocket tunnel to a host so cloud-side operators can drive
this machine.

For running it as an OS-managed background service, see
[`daemon.md`](./daemon.md) — same binary, same flags, just wrapped in
launchd / systemd.

## Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `--workspace <dir>`, `-w` | `process.cwd()` (or `daemon.workspace` in config) | Workspace directory the daemon binds to. Must exist + be a directory. |
| `--port <n>`, `-p` | `18790` | HTTP port. |
| `--bind <ip>`, `-b` | `127.0.0.1` | Bind address. `0.0.0.0` if you want LAN reachability. |
| `--connect <wss-url>`, `-c` | _off_ | Tunnel host URL. When set, daemon connects outbound and adopts every cloud-driven spawn into its local registry. |
| `--token <jwt>`, `-t` | _from credentials.json_ | Tunnel bearer. See resolution order below. |
| `--label <name>`, `-l` | `username@hostname` | Friendly label sent in tunnel hello frames. |
| `--allow-origin <url>` (repeatable) | _localhost only_ | Browser origins trusted to drive mutating routes + the PTY WS. Merged with `daemon.allowedOrigins` from config. |
| `--interactive`, `-i` | off | Chain `agentproto sessions --watch` as a child in the same terminal — quit the TUI to tear the daemon down. |

### Token resolution (`--connect` mode)

1. `--token <jwt>`
2. `$AGENTPROTO_TOKEN`
3. `~/.agentproto/credentials.json[<host>]` (set by
   [`auth login`](./auth.md))

Expired credentials are still sent — the host's 401 surfaces a
clearer error than a silent disconnect — but `serve` prints a warning
suggesting `agentproto auth login --host <host>`.

### Origins

By default, any `Origin` that resolves to `127.0.0.1:*` /
`localhost:*` is trusted, plus anything in `--allow-origin` and
`daemon.allowedOrigins`. Set `daemon.strictOrigins=true` (via
[`config`](./config.md)) to drop the localhost default and trust
**only** the explicit allowlist — for hardened / shared-host setups.

The Bearer-token check on `/mcp` and other routes is independent of
the Origin check — a valid token bypasses the Origin allowlist.

## Modes

### Local-only

```bash
agentproto serve
agentproto serve --workspace ~/code/my-project --port 18791
```

No tunnel, no `--connect`. Local clients (web spawn dialogs running
in the browser, `agentproto sessions`, MCP clients) talk to
`http://127.0.0.1:18790`. Discover the URL + token from
`~/.agentproto/runtime.json` (written at boot).

### Tunnel

```bash
agentproto auth login --host wss://guilde.work
agentproto serve --connect wss://guilde.work/api/v1/agentproto/tunnel
```

Boots the same local gateway *and* opens a WS to the host. Every
tunnel-driven spawn is also registered locally — operators dispatching
from the cloud land in the same `/sessions` list as local ones, so
the LocalDaemonSessionsCard, `agentproto sessions`, etc. all see them.

Reconnect-with-backoff (1s → 30s ceiling) is built in. The local
gateway stays up across reconnects; only the WS cycles. Keep-alive
pings every 30s prevent reverse-proxies (Cloud Run, …) from closing
idle sockets.

### Interactive (`--interactive` / `-i`)

```bash
agentproto serve --workspace ~/code --interactive
```

Spawns the watch TUI as a child after boot, inheriting stdio. Quitting
the TUI (q / Ctrl-C) tears the daemon down. Use the PTY-attach detach
chord (`Ctrl-]` then `q`) to leave the TUI while keeping the daemon
running.

## Boot banner

```text
─ agentproto · gateway up · http://127.0.0.1:18790 ─
  workspace    ~/code/my-project
  pty          enabled (node-pty)
  origins      localhost:* only (default)
  endpoints    /mcp · /sessions · /events · /sessions/:id/pty (WS)
  mode         tunnel → wss://guilde.work/api/v1/agentproto/tunnel
```

Each line is a quick sanity check:

- `pty` — whether `node-pty` was loadable. Without it, PTY-backed
  session routes return 501. Install with `npm i -g node-pty`.
- `origins` — `STRICT` when `daemon.strictOrigins=true`. Empty
  strict allowlist is highlighted red (everything 401s except
  Bearer-token requests).
- `mode` — `local-only` or `tunnel → <url>`.

## When to use `serve` vs `daemon install`

- **`agentproto serve`** — run-as-foreground, Ctrl-C to stop. Good
  for development, debugging the tunnel, `--interactive` TUI.
- **`agentproto daemon install`** — same code, run by launchd /
  systemd. Survives logout/login and crashes. Pick this for
  "always-on" tunnels.

Both read the same `~/.agentproto/config.json`.

## Shutdown

`SIGINT`, `SIGTERM`, and `SIGHUP` all trigger a clean shutdown
sequence: stop accepting new requests → close the tunnel → stop the
gateway → delete the daemon's `runtime.json`. The exit banner is
`── shutting down (<signal>) ──`.

## Files written

| Path | What |
|------|------|
| `<workspace>/.agentproto/runtime.json` | Daemon discovery descriptor: `{ port, bind, token, pid }`. Other CLI invocations (`agentproto sessions`) read this to talk to the daemon. Deleted on clean shutdown. |

Stale `runtime.json` files (dead PID) in registered workspaces are
swept at boot — they confuse discovery otherwise.
