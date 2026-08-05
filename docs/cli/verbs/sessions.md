# `agentproto sessions`

```text
agentproto sessions                                one-shot table dump
agentproto sessions --watch [--simple] [--no-color]
agentproto sessions --attach <id-or-name> [--no-color]
agentproto sessions --json                         JSON dump
agentproto sessions start    <adapter> [--cwd <dir>] [--workspace <slug>]
                                       [--model <id>] [--base-url <url>]
                                       [--auth-token <token>]
                                       [--options-json <json|@file>]
                                       [--prompt <text>] [--label <text>]
                                       [--title <text>]
                                       [--orchestrator | --orchestrator-json <json>]
                                       [--mcp-servers-json <json|@file>]
                                       [--hold-permissions]
                                       [--attach] [--json] [--no-color]
agentproto sessions terminal -- <argv...> [--cwd <dir>] [--workspace <slug>]
                                          [--name <slug>] [--label <text>]
                                          [--cols <n>] [--rows <n>]
                                          [--attach] [--json] [--no-color]
agentproto sessions restart  <id-or-name> [--attach] [--json] [--no-color]
agentproto sessions mirror   <id-or-name> [--no-color]
agentproto sessions story    <id-or-name> [--json] [--no-color]
                                          [--source auto|native|daemon]
agentproto sessions export   <id-or-name> [--json] [-o <file>]
                                          [--source auto|native|daemon]
                                          [--adapter <slug>] [--cwd <dir>]
agentproto sessions stop     <id-or-name> [--json]
agentproto sessions gc       [--older-than-days <n>] [--forget] [--json]
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

When any session was spawned inside a git worktree, a `WORKTREE` column is
inserted between `WORKSPACE` and `STATUS` showing the worktree's leaf directory
name. The full path and the worktree id are shown in the `--watch` detail pane
and in `--json`.

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
| `--model <id>` | Adapter model option. |
| `--base-url <url>` | Manifest `base_url` option (claude-code/claude-sdk) — injected as `ANTHROPIC_BASE_URL`. |
| `--auth-token <token>` | Manifest `auth_token` option — injected as `ANTHROPIC_AUTH_TOKEN`. |
| `--auth subscription\|api-key` | Deterministic billing-auth mode + inline credential for adapters that declare it (today: claude-code). This is the *inline* billing selector; the first-class config axis is a **named auth profile** (`access.profileRef`) — see [Config axes](#config-axes-mcphttp). |
| `--options-json <json\|@file>` | Object form of manifest-declared AIP-45 options; merged with `--base-url`/`--auth-token`/`--auth`/`--model`/`--effort` (discrete flags win on collision). |
| `--prompt <text>`, `-p` | Initial user turn. |
| `--label <text>` | UI label for this session. |
| `--title <text>` | Display title (auto-derived fallback) for this session. |
| `--orchestrator` | Make this child a scoped **orchestrator** — the daemon mounts a scoped sub-gateway into the session so it can spawn + supervise its own sub-agents. |
| `--orchestrator-json <json>` | Object form of the above: `{"tools":[…],"maxDepth":N,"maxChildren":N}`. Wins over `--orchestrator` when both are passed. |
| `--mcp-servers-json <json\|@file>` | Inject MCP servers (`AcpMcpServer[]`) into the session — inline JSON array, or `@path` to read it from a file. |
| `--hold-permissions` | Start in **permission-hold mode**: every tool-permission request the agent raises is parked in the cross-session inbox instead of auto-answered. Approve/deny with [`permissions.md`](./permissions.md). |
| `--attach` | Attach immediately after spawn. |
| `--json` | Emit the session descriptor as JSON instead of a friendly line. |

There is no `--role` / `--prompt-append` flag on this verb today —
spawn-time role gating (whether this child may itself delegate, and
to whom) is MCP/HTTP-only: the `agent_start` MCP tool's `role` /
`promptAppend` fields, or the same fields on the `POST /sessions/agent`
body. See [`concepts/roles.md`](../concepts/roles.md).

#### Session identity env

Every process the daemon spawns on a session's behalf — an agent-CLI adapter
(this verb), a `terminal -- <argv...>` PTY, or a `command_execute` /
cron `kind:"command"` shell command — gets two env vars set into its own
process environment:

| Var | Value |
|---|---|
| `AGENTPROTO_SESSION_ID` | The spawned session's own id (`sess_…`) — the same id `session_list`/`agent_sessions_list` show for it. |
| `AGENTPROTO_WORKSPACE_SLUG` | The workspace slug the session resolved to (`"default"` when none). |

A hook, script, or tool a session shells out to can read these to report
back, tag telemetry, or spawn a further child with `parentSessionId` set to
its own id — closing the loop for e.g. a `git push` hook that spawns a
reviewer session and wants it nested under the session that triggered it.

Both are set **last**, after any other env the spawn composes (manifest
defaults, billing-auth, a caller-supplied `env` on `POST /sessions` or
`POST /sessions/terminal`) — a caller can never override or forge them, and
a session never inherits a value from the daemon's own process env. Every
spawn — including a resumed/restarted one — gets its own freshly minted id;
`session_restart` mints a new id (see `resumedFrom` on the descriptor for
lineage back to the prior one), while the daemon's own crash/restart-time
lazy resume revives the same descriptor row and so keeps the same id.
`label`/`name` are deliberately not carried into env — they're optional,
mutable, and absent on most sessions; look one up via
`AGENTPROTO_SESSION_ID` + `session_list` instead.

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

#### Permission hold mode (`--hold-permissions`)

By default a spawned agent's tool-permission requests (Write, Bash, …) are
auto-answered in the driver so the turn never blocks. With
`--hold-permissions` each request is instead **surfaced and parked** in the
daemon's cross-session inbox — the agent's turn blocks until a human or
orchestrator approves or denies it:

```bash
agentproto sessions start claude-code --workspace my-app --hold-permissions
# … the agent tries to Write a file …
agentproto permissions ls                 # see what's held, across every session
agentproto permissions approve <id>       # unblock (allow-once)
agentproto permissions approve <id> --always   # allow-always, if offered
agentproto permissions deny <id>          # reject
```

Same capability over MCP (`agent_start { permissionHold: true }` +
`permissions_list` / `permissions_respond`) and HTTP
(`POST /sessions/agent { permissionHold: true }`, `GET /permissions`,
`POST /permissions/:id`). A held session renders with a `!` badge in `--watch`. See
[`permissions.md`](./permissions.md) for the full inbox verb. ACP adapters
only (e.g. claude-code); adapters with no permission surface ignore the flag.

#### Sandbox (MCP/HTTP only — no CLI flag yet)

`agent_start` accepts a `sandbox` field that boots the session inside an
isolated cloud sandbox instead of the local machine, via a pluggable
`SandboxProvider` (e2b's Firecracker microVMs ship today —
`@agentproto/sandbox-e2b`). The daemon boots the box, starts its own
sub-daemon inside it, and proxies the session's turns back over that box's
MCP endpoint (`SandboxAgentSessionProxy`) — from the outside it behaves like
any other session. Supports reconnecting to an existing sandbox id and
pausing it on close (AIP-36 lifecycle) instead of tearing it down.

Only reachable today via the MCP `start_agent_session` tool or
`POST /sessions/agent`, not a `sessions start` CLI flag. Companion MCP tools:
`list_sandbox_providers` (see what's configured) and
`setup_sandbox_provider` (register credentials for one).

#### `commandSandbox` (MCP/HTTP only — no CLI flag yet) — NOT the same thing as `sandbox`

**Do not confuse this with `sandbox` above.** `sandbox` boots a whole SEPARATE
machine/box and runs the session there. `commandSandbox` is a completely
different, much smaller mechanism: it wraps the adapter's OWN spawned
process on THIS host — the same argv `agent_start` would have run anyway —
through an OS-level confinement backend (macOS Seatbelt / Linux bubblewrap,
`@agentproto/command-sandbox`, the same backends `command_execute` already
uses). It denies the adapter's process tree filesystem access outside the
session's `cwd`, confinement an ACP permission seam can never give you since
it only sees tool calls the adapter chooses to report, not what an
in-process Bash actually touches. The two fields are independent — set
either, both, or neither; `commandSandbox` is ignored for a `sandbox` spawn
(the box's own daemon would need to apply it itself).

Values: `"off"` (default — unconfined, unchanged behaviour), `"workspace"`
(deny reads/writes to `$HOME` outside the workspace — protects `~/.ssh`,
`~/.aws`, credentials, …; network stays allowed), `"strict"` (`"workspace"`
+ deny all network). `"workspace"`/`"strict"` FAIL the spawn outright if no
backend is installed for the platform (macOS needs `sandbox-exec`, Linux
needs `bwrap`) — it never silently falls back to running unconfined.

A workspace can set this persistently instead of passing it on every
`agent_start` call, via the `adapterSpawn` key of `.agentproto/
command-sandbox.json`:

```json
{
  "mode": "off",
  "adapterSpawn": {
    "mode": "workspace",
    "extraReadPaths": [],
    "extraWritePaths": [],
    "network": "allow"
  }
}
```

Note the top-level `mode` (read by `command_execute`) and `adapterSpawn.mode`
(read for the adapter-spawn axis above) are DELIBERATELY separate keys in the
same file, not one shared setting — a misconfigured `command_execute` jail
breaks one shell command; a misconfigured adapter-spawn jail breaks the
WHOLE session for as long as the adapter runs, a strictly bigger blast
radius that needs its own explicit opt-in. An explicit `agent_start.
commandSandbox` call always overrides the file. `AGENTPROTO_ADAPTER_COMMAND_SANDBOX_MODE`
is the env-var escape hatch for the adapter axis (mirroring
`AGENTPROTO_COMMAND_SANDBOX_MODE` for `command_execute` — the two vars are
also separate, on purpose).

#### Config axes (MCP/HTTP)

A session's behaviour is configured along a fixed set of **axes** — the unified
surface that replaces the older overloaded `mode` concept. Each is set at spawn
(`agent_start` / `POST /sessions/agent`) and, where it can apply live, switched
mid-session:

| Axis | What it controls | Values |
|------|------------------|--------|
| `model` | route-identity ref | `[route:]vendor/product[:pin][@route]` |
| `effort` | reasoning/compute budget | `low\|medium\|high\|xhigh\|max\|ultracode` |
| `access` | a **named** auth profile (`access.profileRef`), not an inline token | profile ref eligible for the resolved (adapter × route) |
| `route` | endpoint/gateway rail | `anthropic\|openrouter\|requesty\|…` |
| `posture` | what the agent may **do** | `default\|plan\|accept-edits\|bypass\|read-only` (or a raw harness mode id) |
| `contextProfile` | what enters context | `full\|lean\|…` |

**Live switches** — best-effort, mid-session, no restart. Each returns
`{applied:false, reason}` (rather than throwing) when the running adapter can't
apply it live:

- `agent_set_model { sessionId, model }`
- `agent_set_effort { sessionId, effort }`
- `agent_set_posture { sessionId, posture }`

An axis that can't switch live (e.g. `requires-restart`) can be re-applied
through [restart-with-override](#restart-id-or-name). `posture` supersedes the
legacy `mode`/`--auth`-only framing for "what the agent may do" and "which
wallet pays"; use `catalog_models` (see [`models.md`](./models.md)) to discover
which `(model, route)` pairs are actually runnable given the configured auth
profiles.

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

**Restart-with-override (MCP/HTTP).** The `session_restart` MCP tool (and the
`POST /sessions/:id/restart` route) accept per-axis overrides — `model`,
`effort`, `posture`, `route`, `access.profileRef`, and `contextProfile` (plus a
legacy `mode`). An omitted axis is carried forward from the prior session; an
axis set here wins. A restart carrying **any** override is treated as a config
change: it re-resolves auth and takes the forced agent-resume path (bypassing
the PTY-native `claude --resume` branch, which can't re-resolve billing or apply
an axis). This is the way to apply an axis that a [live switch](#config-axes-mcphttp)
reported as `requires-restart`. Only agent-CLI sessions have axes to override —
a PTY/command restart with overrides is rejected `400`.

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

### `story <id-or-name>`

```bash
agentproto sessions story ses_abc12
agentproto sessions story claude-tui --json
agentproto sessions story ses_abc12 --source daemon
```

CLI parity for the `agentproto_session_story` MCP App: parses the session's
transcript and renders it as chapters/steps (a human-readable narrative of
what the agent did) instead of raw events. Takes the same `--source
auto|native|daemon` backend selection as `export` above. `--json` emits the
structured `{ sessionId, adapter, chapters, steps }` shape instead of the
rendered terminal view.

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

### `gc`

```bash
agentproto sessions gc                         # print plan, archive eligible
agentproto sessions gc --apply                 # actually archive
agentproto sessions gc --forget                # drop descriptors instead of archiving
agentproto sessions gc --older-than-days 7 --apply
```

Bulk garbage-collects terminal-status sessions (`exited`/`killed`/`error`).
By default it **archives** them (hidden from the default view, still
readable/importable) via `POST /sessions/gc`. Pass `--forget` to drop the
descriptors instead (the native conversation on disk survives). `--older-than-days`
keeps anything more recent. Live sessions are never touched.

## Interrupting a live session (MCP/HTTP only)

There is no `agentproto sessions` subverb for this — it's exposed on
the MCP `agent_prompt` tool and the HTTP prompt route only:

```text
MCP:  agent_prompt { sessionId, prompt, interrupt: true }
HTTP: POST /sessions/:id/prompt?wait=false  { "prompt": "...", "interrupt": true }
```

By default, sending a prompt to a session that's still mid-turn is
rejected (see [`chat.md`](./chat.md#prompt-delivery) — `409
send_prompt_failed`, "...is mid-turn — wait for it to finish or
cancel"). Passing `interrupt: true` changes that: the daemon cancels
the in-flight turn (the adapter's own soft Ctrl-C — ACP
`session/cancel`, or an adapter-specific SIGINT), waits for it to
actually settle, then delivers the new prompt on the **same** live
session — same process, same conversation history, no re-spawn.
`interrupt` is a no-op when the session is already idle.

This is deliberately narrower than `restart` or `stop`:

| Action | Effect |
|--------|--------|
| `interrupt: true` on `agent_prompt` / prompt route | Cancels the current turn only; session and context survive; next prompt continues the same conversation. |
| [`stop`](#stop-id-or-name) | Kills the process outright (SIGTERM). Conversation ends unless you `restart`. |
| [`restart`](#restart-id-or-name) | Re-spawns from history, attempting to resume via the adapter's own session id — a new process, not a redirect of a live one. |

A few edge cases worth knowing:

- If the adapter's session handle doesn't support cancellation, the
  call fails with a clear error rather than silently dropping the new
  prompt.
- The daemon waits up to 30s for the cancelled turn to settle
  (`busy` flipping back to `false`) before giving up — a safety net
  for an adapter that never delivers a turn-end for the turn it just
  cancelled, not the normal path.
- On the HTTP route, `interrupt` only takes effect with
  `?wait=false` (the fire-and-forget arm, same one MCP `agent_prompt`
  always uses) — the default blocking `wait=true` call has no
  interrupt semantics of its own since it just waits on `sendPrompt`.

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
- [Roles](../concepts/roles.md) — the spawn-time delegation gate
  behind `agent_start`'s `role` field, the privilege lattice, and the
  `role_list` introspection tool
