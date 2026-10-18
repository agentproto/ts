# `agentproto daemon`

```text
agentproto daemon install [--dry-run]   register service + start it (macOS launchd, Linux systemd --user, Windows Task Scheduler)
agentproto daemon uninstall             stop + deregister service
agentproto daemon start                 start the service (idempotent; never kills healthy)
agentproto daemon restart               kill + relaunch
agentproto daemon stop                  stop the service
agentproto daemon status                installed? running? /health reachable?
agentproto daemon logs [--lines <N>]    tail daemon.log
```

Runs `agentproto serve` as a background service via the host's
service manager. Today: **macOS launchd**, **Linux systemd --user**
(with a detached-serve pidfile fallback when the box has no usable
systemd user session) and **Windows Task Scheduler** (per-user
scheduled task at logon).

The daemon picks up its config from `~/.agentproto/config.json` via
`daemon.*` keys. Configure once, then `daemon install` captures the
snapshot into the plist (Linux: the unit's `ExecStart`; Windows: the
launcher `.cmd`). Re-run `install` after any config change.

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
- **Linux:** `systemd --user` when the session has a usable user
  manager: a generated `~/.config/systemd/user/agentproto.service`
  whose `ExecStart` is the same `[node, cli.mjs, serve, …]` argv
  snapshot the plist/`.cmd` use, with the same captured (and
  start/restart-self-healed) `Environment=PATH`, and stdout+stderr
  appended to `~/.agentproto/daemon.log`. `install` writes the unit,
  `daemon-reload`s and `enable --now`s it; `start`/`restart`/`stop`
  map to `systemctl --user start` / `restart` / `stop`, and `status`
  shows unit + active state + `/health`. **No usable systemd user
  session** (containers, minimal VMs, E2B sandboxes — `systemctl`
  missing or `systemctl --user` cannot connect): every verb falls
  back to a detached `serve` managed through a pidfile at
  `~/.agentproto/agentproto-daemon.pid`, so
  `install`/`start`/`stop`/`restart`/`status` still work (and never
  exit 2); `status` names which mode is active. On headless boxes,
  **lingering** decides whether the service survives logout:
  `install` and `status` print a note when
  `loginctl enable-linger $USER` is off (they never run it for you).
- **Windows:** `agentproto daemon install` registers a **per-user
  scheduled task** (`schtasks /Create /TN agentproto-daemon /SC ONLOGON
  /F` — no admin required) whose payload is a generated
  `~/.agentproto/agentproto-daemon.cmd` launcher that captures the same
  `node cli.mjs serve …` argv snapshot the macOS plist does, and merges
  stdout+stderr into `~/.agentproto/daemon.log`. `install` then starts
  the task once; `start`/`restart`/`stop` map to `schtasks /Run`,
  `/End` + `/Run`, and `/End`. `status` queries the task and probes
  `/health` with the same three-part shape as the macOS branch. The
  task runs at user logon, so the daemon survives closing the terminal
  window.

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

`install` also prints the exact `node` + CLI `entry` it captured, and
whether that entry is the published npm install or a **workspace build**
(a monorepo/dev checkout). When it is a workspace build the service would
run that local folder, so it warns loudly with the npm fix:

```text
agentproto daemon: service will run:
  node:    /Users/me/.nvm/versions/node/v22.22.0/bin/node  (nvm, global prefix /Users/me/.nvm/versions/node/v22.22.0)
  entry:   /code/agentproto/packages/cli/dist/cli.mjs
  source:  workspace build (LOCAL FOLDER — not the npm install)
  ! this is a workspace/dev checkout, not the npm-installed CLI — the service
    will run that local folder. To run the published CLI instead:
      npm i -g @agentproto/cli@latest   (then re-run: agentproto daemon install)
```

This is the field-observed failure mode: run `agentproto setup` from a
monorepo checkout and the daemon is installed from the local `dist/` instead
of npm. `agentproto doctor`/`agentproto setup` flag the same thing in their
preflight step.

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

**Sandbox sessions survive a restart.** A session running in a provider box
(`agent_start.sandbox` / `sessions start --sandbox`, e2b/Box/…) is *detached*,
not killed, when the daemon stops or restarts: the host drops its connection
and leaves the box and its agent session running. `restart` prints how many
sessions are being detached before it kickstarts, and after boot waits for the
new daemon's reattach pass and prints the tally:

```
agentproto daemon: 2 sandbox sessions will be detached (box + agent keep running — not killed) and re-attached after boot
agentproto daemon: restarted …
  sandbox:   re-attaching 2 sandbox sessions…
  sandbox:   re-attached 2/2 sandbox sessions
```

The `re-attaching N sandbox sessions…` progress line prints as soon as the new
daemon is up. `restart` waits at most 60 s for the pass; each row is itself
capped at 30 s inside the daemon (`AGENTPROTO_REATTACH_TIMEOUT_MS`). If the pass
hasn't settled by then, `restart` prints the tally so far, notes that the
re-attach pass continues in the daemon, and points at `agentproto daemon status`
(which also shows the re-attach tally next to the sandbox line).

`daemon stop` reports the detached count too. The same counts are on
`GET /health` and the `daemon_health` MCP tool as
`sandboxSessions: { attached, reattach: { detachedAtBoot, reattached, gone, failed, unserved, pending } }`
(`attached` = what a restart *now* would detach; `reattach` = how the booted
daemon's pass went; `unserved` = detached rows in a workspace bucket this
daemon does not serve, left untouched for the daemon that does and excluded
from `pending`). Details, lifetime bound and failure modes:
[sandbox sessions across a daemon restart](./sessions.md#sandbox-sessions-across-a-daemon-restart).
Device-paired sandboxes and local (non-sandbox) sessions keep the old
behaviour: they end as `killed` / `daemon-restart` and are revived by
`resumeSessionsOnBoot`.

`start`/`restart` also **self-heal the plist's `EnvironmentVariables.PATH`**:
each kickstart probes a login shell for the current PATH and rewrites the
plist if it changed. This removes the need to re-run `daemon install` after
installing new CLI tools (for example via `uv tool install`).

### `status`

```bash
agentproto daemon status
```

Prints a multi-line summary:

```text
agentproto daemon status
  plist:     installed (/Users/me/Library/LaunchAgents/sh.agentproto.plist)
  launchd:   loaded · pid=12345 · state=running
  /health:   ok · v0.20.0 (workspace abc1234, built 2026-09-11T…) · pid 12345 · up 2h  (http://127.0.0.1:18790)
  bin:       /Users/me/.local/share/fnm/node-versions/v22/bin/node /Users/me/.npm/lib/node_modules/@agentproto/cli/cli.mjs
  config:    /Users/me/.agentproto/config.json
  logs:      /Users/me/.agentproto/daemon.log

  recent logs:
    …last 5 lines of daemon.log…
```

The `/health` line now includes **build identity** when the running binary was
built with one: `source` (`workspace` or `published`), short git `sha`, and a
`built` ISO timestamp. This lets you distinguish a workspace distribution from a
published tarball of the same version. `bin` shows the exact Node executable and
script launchd (or the shell) invoked — useful when multiple Node managers are
in play.

Exit code is `0` only when plist exists AND launchctl reports the
service loaded. `/health` reachability is informational — it can be
red briefly during a restart without changing the exit code. On Linux
the same rule applies to the active backend: unit installed AND
active (systemd mode), or a live recorded pid (pidfile-fallback
mode); the `mode:` line always names which one you are in.

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
