# `agentproto sessions`

```text
agentproto sessions                                one-shot table dump
agentproto sessions --watch [--simple] [--no-color]
agentproto sessions --attach <id-or-name> [--no-color]
agentproto sessions --json                         JSON dump
agentproto sessions start    <adapter> [--cwd <dir>] [--workspace <slug>]
                                       [--prompt <text>] [--label <text>]
                                       [--attach] [--json] [--no-color]
agentproto sessions terminal -- <argv...> [--cwd <dir>] [--workspace <slug>]
                                          [--name <slug>] [--label <text>]
                                          [--cols <n>] [--rows <n>]
                                          [--attach] [--json] [--no-color]
agentproto sessions restart  <id-or-name> [--attach] [--json] [--no-color]
agentproto sessions mirror   <id-or-name> [--no-color]
agentproto sessions stop     <id-or-name> [--json]
```

Browse and control the daemon's live sessions — terminals, agent CLIs,
generic commands — from any shell. Requires a running daemon
([`serve.md`](./serve.md) or [`daemon.md`](./daemon.md)).

## Discovery

Sessions discovers the daemon via `<workspace>/.agentproto/runtime.json`
written by `serve` at boot. The token in that file is sent as Bearer
on mutating routes. Override with env:

```bash
AGENTPROTO_DAEMON_URL=http://127.0.0.1:18790 \
AGENTPROTO_DAEMON_TOKEN=<token> \
  agentproto sessions
```

When no daemon is found, the verb lists any **stale** `runtime.json`
files (PID dead) so you can clean them up:

```text
agentproto sessions: no daemon found.
  Start one with `agentproto serve` or set AGENTPROTO_DAEMON_URL.

  found 1 stale runtime.json file(s) (PID dead):
    /Users/me/code/proj/.agentproto/runtime.json  (pid=12345 · 2d old)

  these confuse discovery — delete them and re-run:
    rm /Users/me/code/proj/.agentproto/runtime.json
```

## Subverbs

### One-shot list

```bash
agentproto sessions
agentproto sessions --json
```

Prints a table:

```text
ID         KIND       WORKSPACE  STATUS    AGE       COMMAND
ses_abc12  agent-cli  my-proj    running   3m        claude --print --output-format=json
ses_def34  pty        my-proj    running   1m        bash
ses_ghi56  agent-cli  my-proj    exited    1h        claude --print …
```

### `--watch` (3-pane dashboard, default)

```bash
agentproto sessions --watch
```

Alt-screen TUI: sessions list (left), detail pane with preview (right),
recent events strip, footer with keys. Polls `/sessions` every 2s and
subscribes to `/events` for live updates.

Keys:

| Key | Action |
|-----|--------|
| `↑` / `↓` / `j` / `k` | Move selection |
| `Enter` | Attach to selected (PTY-aware via `runAttach`) |
| `m` | Mirror (read-only attach; Ctrl-C exits cleanly) |
| `R` | Restart selected from history (works on exited/killed too) |
| `K` | Kill selected (POST `/sessions/:id/kill`) |
| `d` | Forget selected (DELETE `/sessions/:id`; exited/killed/error only) |
| `r` | Refresh now |
| `q` / `Ctrl-C` | Quit |

Non-TTY stdin degrades to a one-shot table dump.

### `--watch --simple`

```bash
agentproto sessions --watch --simple
```

The original flat-table picker — same keys minus the detail pane.
Smaller terminals, piping into a pager, or scripted screen-recording.

### `--attach <id-or-name>`

```bash
agentproto sessions --attach ses_abc12
agentproto sessions --attach claude-tui    # by name
```

Attaches to a session. PTY sessions get full bidirectional I/O;
non-PTY sessions get the SSE event stream (read-only). While
attached:

- **`Ctrl-] q`** — detach. Session keeps running on the daemon.
- **`Ctrl-C`** — PTY mode sends it to the child; SSE mode detaches.

### `start <adapter>`

```bash
agentproto sessions start claude-code --workspace my-proj --attach
agentproto sessions start claude-code --cwd ~/code --prompt "review the diff"
agentproto sessions start hermes --label "investigation" --json
```

POSTs `/sessions/agent`. Spawns a persistent agent-CLI session
managed by the daemon — survives the spawning shell and can be
reattached later.

| Flag | Purpose |
|------|---------|
| `--cwd <dir>` | Adapter working dir (absolute resolved). |
| `--workspace <slug>` | Registered workspace to bind to (see [`workspace.md`](./workspace.md)). |
| `--prompt <text>`, `-p` | Initial user turn. |
| `--label <text>` | UI label for this session. |
| `--attach` | Attach immediately after spawn. |
| `--json` | Emit the session descriptor as JSON instead of a friendly line. |

### `terminal -- <argv...>`

```bash
agentproto sessions terminal --name claude-tui --attach -- claude
agentproto sessions terminal -- bash
agentproto sessions terminal --cols 120 --rows 30 -- htop
```

POSTs `/sessions/terminal`. Spawns a PTY-backed session running the
literal `<argv>`. The `--` separator is canonical — everything after
it is forwarded verbatim to the spawn, including flags that would
otherwise be eaten by the verb's parser.

| Flag | Purpose |
|------|---------|
| `--cwd <dir>` | Spawn cwd. |
| `--workspace <slug>` | Registered workspace to bind to. |
| `--name <slug>` | Stable session name (alphanumeric + `-`); used as an alias for attach/stop/restart. |
| `--label <text>` | UI label. |
| `--cols <n>` / `--rows <n>` | Initial PTY dimensions. Default: current terminal size, fallback `80x24`. |
| `--attach` / `--json` / `--no-color` | As above. |

`node-pty` must be installed for PTY routes to work; without it, the
daemon returns 501 and this verb fails.

### `restart <id-or-name>`

```bash
agentproto sessions restart claude-tui
agentproto sessions restart ses_abc12 --attach
```

Looks up the (possibly historical) descriptor and spawns a new
session of the same shape. For agent-CLI sessions, attempts to resume
the conversation via the prior adapter session id; falls back to a
fresh shape when the adapter reports the id is unknown ("session
killed too early to persist"). The banner reports which path was
taken: `(resumed via claude --resume from ses_abc12)` or
`(fresh — resume not available)`.

### `mirror <id-or-name>`

```bash
agentproto sessions mirror claude-tui
```

Read-only attach. For PTY sessions: bytes flow daemon → stdout only;
stdin stays in your shell's normal state and `Ctrl-C` cleanly exits
this Node process without touching the underlying PTY. For non-PTY
sessions: same as `--attach`.

Dead sessions (exited/killed/error) print a hint pointing at
`restart`; the WS upgrade would only return a confusing close 1011
mid-stream.

### `stop <id-or-name>`

```bash
agentproto sessions stop ses_abc12
agentproto sessions stop claude-tui --json
```

POSTs `/sessions/:id/kill` — sends SIGTERM to the child. Idempotent
on already-dead sessions (reports "not running"; exit `1`).

## Examples

```bash
# Start a persistent Claude Code session and attach
agentproto sessions start claude-code --workspace my-app --attach

# Spawn a PTY-backed REPL with a friendly name
agentproto sessions terminal --name claude-tui --attach -- claude

# List, peek, detach
agentproto sessions
agentproto sessions --attach claude-tui    # then Ctrl-] q

# Watch the dashboard, drive interactively
agentproto sessions --watch

# Stop everything you can find
agentproto sessions --json | jq -r '.[].id' | xargs -n1 agentproto sessions stop
```
