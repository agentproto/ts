# `agentproto daemon`

```text
agentproto daemon install [--dry-run]   register service + start it (macOS launchd)
agentproto daemon uninstall             stop + deregister service
agentproto daemon start                 launchctl kickstart (idempotent; never kills healthy)
agentproto daemon restart               launchctl kickstart -k (kill + relaunch)
agentproto daemon stop                  launchctl kill SIGTERM
agentproto daemon status                installed? loaded? /health reachable?
agentproto daemon logs [--lines <N>]    tail daemon.log
```

Runs `agentproto serve` as a background service via the host's
service manager. Today: **macOS launchd only**. Linux (`systemctl --user`)
and Windows ship later; until then the verb prints a clear "not
supported" message and points you at `agentproto serve &; disown`.

The daemon picks up its config from `~/.agentproto/config.json` via
`daemon.*` keys. Configure once, then `daemon install` captures the
snapshot into the plist. Re-run `install` after any config change.

Logs (stdout + stderr) go to `~/.agentproto/daemon.log`.

## Platform notes

- **macOS:** plist at `~/Library/LaunchAgents/sh.agentproto.plist`.
  `RunAtLoad=true`, `KeepAlive` is **crash-only** (`SuccessfulExit=false`),
  `ProcessType=Interactive` (so it stays alive at user login and across
  login/logout). Crash-only means a clean exit-0 stays settled, while a
  crash respawns automatically. The plist's `ProgramArguments` is `[node,
  cli.mjs, serve, …flags]`, computed from `process.execPath` +
  `process.argv[1]` of the install invocation — so the daemon runs on the
  same Node binary that ran `daemon install` (works correctly with `nvm` /
  `fnm` / Homebrew).
- **Linux:** not yet supported. Fall back to
  `agentproto serve &; disown` or your own `systemd --user` unit
  pointing at `agentproto serve`.
- **Windows:** not yet supported.

## Subverbs

### `install`

```bash
# Optional: configure first
agentproto config set daemon.workspace /Users/me/code
agentproto config set daemon.port 18791
agentproto config set daemon.allowedOrigins https://guilde.work
agentproto config set tunnel.host wss://guilde.work/api/v1/agentproto/tunnel
agentproto config set tunnel.autoconnect true
# Optional: end-to-end encrypt the tunnel (needs tunnel.token; the host
# must also support it, else the daemon falls back to plaintext).
agentproto config set tunnel.e2e true

agentproto daemon install
```

> **`tunnel.e2e`** wraps the outbound tunnel in an AEAD box negotiated
> from the shared `tunnel.token`, so even the host can't read the
> frames. It is opt-in and negotiated — an older host that doesn't
> advertise E2E keeps working over the plaintext tunnel. See
> [`serve` → End-to-end encryption](./serve.md#end-to-end-encryption-tunnele2e-opt-in).

Writes the plist, runs `launchctl bootout` on any prior version, then
`launchctl bootstrap gui/<uid>`. Service starts immediately because
of `RunAtLoad`.

`--dry-run` prints the would-be plist + the `launchctl bootstrap`
command without touching the filesystem or launchd. Useful for
verifying the captured flags before committing.

### `uninstall`

```bash
agentproto daemon uninstall
```

`launchctl bootout` + delete plist. Idempotent — "already absent" is
not an error.

### `start` / `restart` / `stop`

```bash
agentproto daemon start    # launchctl kickstart (idempotent; leaves a healthy daemon running)
agentproto daemon restart  # launchctl kickstart -k (kill + relaunch)
agentproto daemon stop     # launchctl kill SIGTERM
```

`start` is idempotent: it asks launchd to start the service if it isn't
running and is a no-op if a healthy daemon already is. It never kills the
incumbent. `restart` is the force-cycle: `kickstart -k` kills the running
daemon (if any) and relaunches it — the clean replacement for manually
killing the port. Crash-only `KeepAlive` means launchd only respawns the
daemon when it exits non-zero; `daemon stop` sends a single SIGTERM and
exits.

`start`/`restart` also **self-heal the plist's `EnvironmentVariables.PATH`**:
each kickstart probes a login shell for the current PATH and rewrites the
plist if it changed. This removes the need to re-run `daemon install` after
installing new CLI tools (for example via `uv tool install`).

### `status`

```bash
agentproto daemon status
```

Prints a four-line summary:

```text
agentproto daemon status
  plist:     installed (/Users/me/Library/LaunchAgents/sh.agentproto.plist)
  launchd:   loaded · pid=12345 · state=running
  /health:   ok · v0.13.0 · workspace=/Users/me/code · up 2h  (http://127.0.0.1:18790)
  config:    /Users/me/.agentproto/config.json
  logs:      /Users/me/.agentproto/daemon.log

  recent logs:
    …last 5 lines of daemon.log…
```

Exit code is `0` only when plist exists AND launchctl reports the
service loaded. `/health` reachability is informational — it can be
red briefly during a restart without changing the exit code.

### `logs`

```bash
agentproto daemon logs              # last 10 lines
agentproto daemon logs --lines 100  # last 100 lines (short: -n 100)
```

Tails `~/.agentproto/daemon.log`.

## When to use the daemon vs `serve` directly

- **`agentproto serve`** — run-as-foreground. Good for ad-hoc
  development, debugging the tunnel, the `--interactive` TUI, or
  short-lived test sessions where Ctrl-C should kill everything.
- **`agentproto daemon`** — managed by the OS. Survives logout/login,
  restarts on crash, logs to a file. Use this when you want the
  tunnel "always up" for a hosted agent (Guilde, etc.).

Both share the same `config.json` so flipping between them is just
which way you launched.
