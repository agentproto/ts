# `agentproto sessions`

```text
agentproto sessions                                one-shot table dump
agentproto sessions --watch [--simple] [--no-color]
agentproto sessions --attach <id-or-name> [--no-color]
agentproto sessions --json                         JSON dump
agentproto sessions start    <adapter> [--cwd <dir>] [--workspace <slug>]
                                       [--prompt <text>] [--label <text>]
                                       [--orchestrator | --orchestrator-json <json>]
                                       [--mcp-servers-json <json|@file>]
                                       [--attach] [--json] [--no-color]
agentproto sessions terminal -- <argv...> [--cwd <dir>] [--workspace <slug>]
                                          [--name <slug>] [--label <text>]
                                          [--cols <n>] [--rows <n>]
                                          [--attach] [--json] [--no-color]
agentproto sessions restart  <id-or-name> [--attach] [--json] [--no-color]
agentproto sessions mirror   <id-or-name> [--no-color]
agentproto sessions export   <id-or-name> [--json] [-o <file>]
                                          [--source auto|native|daemon]
                                          [--adapter <slug>] [--cwd <dir>]
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
| `--orchestrator` | Make this child a scoped **orchestrator** — the daemon mounts a scoped sub-gateway into the session so it can spawn + supervise its own sub-agents. |
| `--orchestrator-json <json>` | Object form of the above: `{"tools":[…],"maxDepth":N,"maxChildren":N}`. Wins over `--orchestrator` when both are passed. |
| `--mcp-servers-json <json\|@file>` | Inject MCP servers (`AcpMcpServer[]`) into the session — inline JSON array, or `@path` to read it from a file. |
| `--attach` | Attach immediately after spawn. |
| `--json` | Emit the session descriptor as JSON instead of a friendly line. |

#### Orchestrator & `mcpServers`

`--orchestrator` and `--mcp-servers-json` reach the same spawn capability as
the `agent_start` MCP tool: the CLI, the HTTP route (`POST /sessions/agent`),
and MCP all delegate to one shared spawn path, so any surface can start an
orchestrator-enabled or `mcpServers`-injected session.

```bash
# Scoped orchestrator — the child can spawn + supervise its own sub-agents
agentproto sessions start claude-code --orchestrator --workspace my-app --attach

# Bound it: at most 2 levels deep, 3 concurrent children
agentproto sessions start claude-code \
  --orchestrator-json '{"maxDepth":2,"maxChildren":3}'

# Inject MCP servers (here: mount the daemon's own gateway into hermes)
agentproto sessions start hermes \
  --mcp-servers-json '[{"name":"agentproto","transport":"http","ref":"http://127.0.0.1:18790/mcp"}]'
```

Both are parsed and validated client-side **before** the daemon round-trip:
malformed JSON, a non-array `--mcp-servers-json`, or an unreadable `@file`
fail fast with exit `2`. `--orchestrator` requires a daemon started with the
scoped orchestrator sub-gateway wired (the default for `agentproto serve`);
otherwise the route returns `501`.

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

### `export <id-or-name>`

```bash
agentproto sessions export ses_abc12
agentproto sessions export claude-tui --json -o transcript.json
agentproto sessions export ses_abc12 --source daemon
```

GETs `/sessions/:id/export` — renders a clean transcript from the
session's structured history (see
[concepts/session-transcripts.md](../concepts/session-transcripts.md)
for what's captured and where). Works on stopped sessions as well as
running ones.

| Flag | Default | Purpose |
|------|---------|---------|
| `--json` | markdown | Emit the raw `ExportedSession` JSON instead of rendered markdown. |
| `--output <file>`, `-o` | stdout | Write to a file instead of stdout. |
| `--source <auto\|native\|daemon>` | `auto` | Which backend to read. `auto` prefers the adapter's own native store (claude-code JSONL, hermes SQLite) and falls back to agentproto's `events.jsonl` capture when there isn't one or it can't be read; `native`/`daemon` force one and surface its own error instead of falling back. |
| `--adapter <slug>` | from registry | Override the adapter slug — required with `--source native` when exporting a raw adapter-native id that isn't in the registry. |
| `--cwd <dir>` | from registry | Override the working directory — required for a claude-code native export when the session isn't in the registry (used to locate the JSONL file). |

The `/sessions/:id/export` route accepts the same `format`
(`markdown`|`json`), `source`, `adapter`, and `cwd` as query params.
On failure it responds `{error: "export_failed", message, sessionId,
adapter}` — `404` when the session/adapter/store couldn't be found at
all, `422` for any other export error (e.g. a native store that
failed to parse). `--source` values other than `auto`/`native`/`daemon`
are rejected client-side by the CLI (exit `2`) before any request is
made.

### `stop <id-or-name>`

```bash
agentproto sessions stop ses_abc12
agentproto sessions stop claude-tui --json
```

POSTs `/sessions/:id/kill` — sends SIGTERM to the child. Idempotent
on already-dead sessions (reports "not running"; exit `1`).

## Raw events (HTTP)

```text
GET /sessions/:id/events?since=<seq>&limit=<n>
```

No CLI subverb wraps this — it's an HTTP-only route for a frontend
that wants the raw, per-kind records (tool calls, plans, usage
updates, …) instead of the collapsed markdown/JSON `/export` gives.
It reads the same `events.jsonl` agentproto's daemon-events export
strategy reads (see
[concepts/session-transcripts.md](../concepts/session-transcripts.md)).

| Query param | Default | Notes |
|-------------|---------|-------|
| `since` | `0` | Only return records with `seq` greater than this cursor. Must be a non-negative integer or the route 400s (`invalid_since`). |
| `limit` | `500` | Max records per call, clamped to `[1, 2000]`. |

Response: `{sessionId, events, nextSeq, complete}` — `events` is the
raw parsed JSONL objects (`seq > since`, capped at `limit`); `nextSeq`
is the last returned event's `seq` (or `since` unchanged if nothing
matched); `complete` is `false` when more events exist beyond
`limit` — poll again with `since=nextSeq` to keep draining. `404`
(`no_transcript`) when the session never wrote an `events.jsonl` (a
PTY/command session, or an agent-cli session that predates this
feature).

## Examples

```bash
# Start a persistent Claude Code session and attach
agentproto sessions start claude-code --workspace my-app --attach

# Start a scoped orchestrator that can spawn + supervise sub-agents
agentproto sessions start claude-code --orchestrator --attach

# Spawn a PTY-backed REPL with a friendly name
agentproto sessions terminal --name claude-tui --attach -- claude

# List, peek, detach
agentproto sessions
agentproto sessions --attach claude-tui    # then Ctrl-] q

# Watch the dashboard, drive interactively
agentproto sessions --watch

# Stop everything you can find
agentproto sessions --json | jq -r '.[].id' | xargs -n1 agentproto sessions stop

# Export a transcript once the session is done
agentproto sessions export ses_abc12 -o transcript.md
```

## See also

- [Session transcripts](../concepts/session-transcripts.md) — what's
  captured in `events.jsonl`, event kinds, native vs daemon export
  sources, the PTY exception
- [`chat.md`](./chat.md) — sending follow-up prompts to a live
  session, incl. what happens when the target is dead or mid-turn
