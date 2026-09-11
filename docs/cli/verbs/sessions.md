# `agentproto sessions`

```text
agentproto sessions                                one-shot table dump
agentproto sessions --watch [--no-color]
agentproto sessions --attach <id-or-name> [--no-color]
agentproto sessions --json                         JSON dump
agentproto sessions start    <adapter> [--cwd <dir>] [--workspace <slug>]
                                        [--model <id>] [--base-url <url>]
                                        [--auth subscription|api-key]
                                        [--auth-token <token>]
                                        [--options-json <json|@file>]
                                        [--access-profile <ref>]
                                        [--worktree | --no-worktree]
                                        [--mode <id>] [--effort <level>]
                                        [--prompt <text>] [--label <text>]
                                        [--title <text>]
                                        [--orchestrator | --orchestrator-json <json>]
                                        [--mcp-servers-json <json|@file>]
                                        [--sandbox <provider-or-json|@file>]
                                        [--hold-permissions]
                                        [--attach] [--json] [--no-color]
agentproto sessions terminal [--preset <name>] [-- <argv...>]
                                           [--cwd <dir>] [--workspace <slug>]
                                           [--name <slug>] [--label <text>]
                                           [--cols <n>] [--rows <n>]
                                           [--attach] [--json] [--no-color]
agentproto sessions prompt   <id-or-name> --prompt <text> [--wait] [--interrupt]
                                           [--force] [--json]
agentproto sessions pin      <id-or-name> [--json]
agentproto sessions unpin    <id-or-name> [--json]
agentproto sessions mirror   <id-or-name> [--no-color]
agentproto sessions story    <id-or-name> [--json] [--no-color]
                                           [--source auto|native|daemon]
agentproto sessions export   <id-or-name> [--json] [-o <file>]
                                           [--source auto|native|daemon]
agentproto sessions stop     <id-or-name> [--json]
agentproto sessions wait     <id-or-name> [--until <event>] [--timeout <duration>]
                                           [--policy <policyId>] [--json]
agentproto sessions gc       [--older-than-days <n>] [--forget] [--json]
agentproto sessions queue    <id-or-name> [--force <n>] [--deliver <n>]
                                           [--drop <n>] [--json]
```

Browse and control the daemon's live sessions — terminals, agent CLIs,
generic commands — from any shell. Requires a running daemon
([`serve.md`](./serve.md) or [`daemon.md`](./daemon.md)).

## Discovery

Sessions discovers the daemon by trying candidates in this order — the
first live one wins:

1. `AGENTPROTO_DAEMON_URL` env var (token from
   `AGENTPROTO_DAEMON_TOKEN`, or looked up from a matching
   `runtime.json` if unset):
2. `~/.agentproto/runtime.json`, only if its pid is still alive;
3. the central registry `~/.agentproto/daemons/<port>.json`, for the
   port declared in `config.json` (falling back to any other live
   entry);
4. each configured workspace's own
   `<workspace>/.agentproto/runtime.json` (written by `serve` at boot).

A descriptor whose pid is dead is ignored, never trusted. The token
from whichever candidate wins is sent as Bearer on mutating routes:

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
PIN ID         KIND       WORKSPACE  STATUS    AGE       COMMAND
●   ses_abc12  agent-cli  my-proj    running   3m        claude --print --output-format=json
    ses_def34  pty        my-proj    running   1m        bash
    ses_ghi56  agent-cli  my-proj    exited    1h        claude --print …
```

Pinned sessions sort to the top and are marked with `●` in the `PIN`
column. Pinning is list-visibility only — it does not affect
keep-alive, the idle reaper, or notifications.

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
| `s` | Show the selected session's Story / conversation |
| `r` | Refresh now |
| `q` / `Ctrl-C` | Quit |

Non-TTY stdin degrades to a one-shot table dump.

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
| `--sandbox <provider-or-json\|@file>` | Spawn inside an isolated sandbox box instead of the local host. Pass a provider slug (e.g. `e2b` or `box`, configured via `setup_sandbox_provider`) or an inline AIP-36 `SandboxDefinition` JSON object (optionally with `{"reuse":"<sandboxId>"}` for reconnect). `@file` reads the slug or JSON from a file. Mirrors `agent_start.sandbox`. |
| `--access-profile <ref>` | Bill this spawn through a named auth profile (CLI twin of `agent_start`'s `access.profileRef` — pin endpoint + credential, never silently the default). Overrides the daemon's default profile. See [Config axes](#config-axes-mcphttp). |
| `--worktree` | Isolate this spawn in its own git worktree (auto-minted slug/branch on `origin/main`) regardless of the daemon's `worktrees.isolation` policy. Mirrors `agent_start.worktree=true`. |
| `--no-worktree` | Spawn in cwd directly, overriding an isolation policy that would otherwise isolate. Mirrors `agent_start.worktree=false`. |
| `--mode <id>` | Manifest-declared posture mode id applied at spawn (e.g. claude-code `plan`, codex `read-only`). Mirrors `agent_start.mode`. |
| `--effort <level>` | Reasoning effort — `low\|medium\|high\|xhigh\|max\|ultracode`, calibrated per model. Mirrors `agent_start.effort`. |
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
cron `kind:"command"` shell command — gets these identity env vars set into
its own process environment. The first two are always present; the third is
added only for agent-CLI children that resolved a `parentSessionId`:

| Var | Value |
|---|---|
| `AGENTPROTO_SESSION_ID` | The spawned session's own id (`sess_…`) — the same id `session_list`/`agent_sessions_list` show for it. |
| `AGENTPROTO_WORKSPACE_SLUG` | The workspace slug the session resolved to (`"default"` when none). |
| `AGENTPROTO_PARENT_SESSION_ID` | The id of the session that spawned this one. Present only for nested agent-CLI children; lets a child report back via the `message_parent` MCP tool without a registry round-trip. |

A hook, script, or tool a session shells out to can read these to report
back, tag telemetry, or spawn a further child with `parentSessionId` set to
its own id — closing the loop for e.g. a `git push` hook that spawns a
reviewer session and wants it nested under the session that triggered it.

These are set **last**, after any other env the spawn composes (manifest
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

#### Implicit spawn deduplication

`agent_start` deduplicates spawns by default. When a spawn has a `label` and no
explicit `idempotencyKey`, the daemon derives an implicit key from the label
plus a hash of the initial `prompt`; a repeat with the same adapter, cwd, and
key within ~2 minutes returns the existing session instead of forking a second
one. Unlabelled spawns are never deduped, so deliberate parallel fan-out into
one cwd is still safe.

Control the policy with the `spawn.dedupe` config field or the
`AGENTPROTO_SPAWN_DEDUPE` env var:

- `"always"` (default) — derive an implicit key whenever a label is present.
- `"on-request"` — only an explicit `idempotencyKey` dedupes (pre-default behaviour).

Over MCP/HTTP, pass `dedupe: false` on a single spawn to opt out regardless of
the policy. `session_restart` always mints a new session id and is unaffected.

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

#### Sandbox

`agent_start` (and the `--sandbox` CLI flag above) boot the session inside
an isolated cloud sandbox instead of the local machine, via a pluggable
`SandboxProvider` (e2b's Firecracker microVMs ship today —
`@agentproto/sandbox-e2b`). The daemon boots the box, starts its own
sub-daemon inside it, and proxies the session's turns back over that box's
MCP endpoint (`SandboxAgentSessionProxy`) — from the outside it behaves like
any other session. Closing the session **pauses** the box by default
(AIP-36 lifecycle) — it stays reattachable via `agentproto sandbox attach`
or `sandbox.reuse`. An explicit `lifecycle.destroy_on` declaration kills
the box instead.

Reachable via the `--sandbox` flag (CLI), the MCP `agent_start` tool's
`sandbox` field, or `POST /sessions/agent`. Companion MCP tools:
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
through [restart-with-override](#restarting-a-session). `posture` supersedes the
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
| `--name <slug>` | Stable session name (alphanumeric + `-`); used as an alias for attach/stop. |
| `--label <text>` | UI label. |
| `--cols <n>` / `--rows <n>` | Initial PTY dimensions. Default: current terminal size, fallback `80x24`. |
| `--attach` / `--json` / `--no-color` | As above. |

`node-pty` must be installed for PTY routes to work; without it, the
daemon returns 501 and this verb fails.

### Restarting a session — no CLI subverb

There is **no `agentproto sessions restart` subverb** — a command in that
shape exits with a usage error. Restart exists on two other surfaces:

- **The `R` key inside `agentproto sessions --watch`** — restarts the
  selected session from history (works on exited/killed sessions too).
- **The `session_restart` MCP tool**, and the equivalent
  `POST /sessions/:id/restart` HTTP route — for agent-driven restarts.

```text
MCP:  session_restart { sessionId }
HTTP: POST /sessions/:id/restart
```

Restart looks up the (possibly historical) descriptor and spawns a new
session of the same shape. For agent-CLI sessions, it attempts to resume
the conversation via the prior adapter session id; it falls back to a
fresh shape when the adapter reports the id is unknown ("session
killed too early to persist"). The banner reports which path was
taken: `(resumed via claude --resume from ses_abc12)` or
`(fresh — resume not available)`. The new session gets a freshly minted
id; `resumedFrom` on the descriptor records the lineage.

**Restart-with-override (MCP/HTTP).** `session_restart` and the
`POST /sessions/:id/restart` route accept per-axis overrides — `model`,
`effort`, `posture`, `route`, `access.profileRef`, and `contextProfile` (plus a
legacy `mode`). An omitted axis is carried forward from the prior session; an
axis set here wins. A restart carrying **any** override is treated as a config
change: it re-resolves auth and takes the forced agent-resume path (bypassing
the PTY-native `claude --resume` branch, which can't re-resolve billing or apply
an axis). This is the way to apply an axis that a [live switch](#config-axes-mcphttp)
reported as `requires-restart`. Only agent-CLI sessions have axes to override —
a PTY/command restart with overrides is rejected `400`.

### `prompt <id-or-name>`

```bash
agentproto sessions prompt claude-tui --prompt "check the PR comments"
agentproto sessions prompt claude-tui --prompt "stop and fix this" --interrupt
agentproto sessions prompt claude-tui --prompt "one more thing" --wait
```

POSTs `/sessions/:id/prompt` to send a follow-up message into an
already-running session. Default is fire-and-forget and queued behind any
in-flight turn — the reply is not printed; read it back with
[`story`](#story-id-or-name) or [`export`](#export-id-or-name).

| Flag | Purpose |
|------|---------|
| `--prompt <text>`, `-p` | Message to send (required). |
| `--wait` | Block until the turn this prompt starts has drained. |
| `--interrupt` | Cancel the in-flight turn and dispatch immediately instead of queuing. |
| `--force` | Jump the prompt queue (only meaningful without `--wait`). |
| `--json` | Emit the raw server response as JSON. |

### `pin <id-or-name>` / `unpin <id-or-name>`

```bash
agentproto sessions pin claude-tui
agentproto sessions unpin ses_abc12
```

POSTs `/sessions/:id/pin`. A pinned session sorts to the top of the
`sessions` table and the VS Code "Pinned" group, marked with a `PIN`
indicator. Pinning is list-visibility only — it has no effect on
keep-alive, the idle reaper, or notifications.

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

Note there are **no `--adapter` / `--cwd` CLI flags** on `export` in
0.20.0 — an export of a session that isn't in the registry (where the
adapter slug or cwd would need overriding) is only reachable through the
HTTP route below, which still accepts `adapter` and `cwd` query params.

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

### `wait <id-or-name>`

```bash
agentproto sessions wait ses_abc12
agentproto sessions wait ses_abc12 --until turn-end --timeout 5m
agentproto sessions wait --policy pol_abc12 --timeout 2m
```

Blocking long-poll: blocks the caller until the session fires a lifecycle
event or the timeout expires. Chains calls across the daemon's ~55s
per-call ceiling so the CLI-side timeout can be arbitrarily long.

This is the scriptable equivalent of the `session_monitor` MCP tool, but
without the 49s MCP constraint — prefer it when you have shell access.

| Flag | Default | Description |
|------|---------|-------------|
| `--until <event>` | `any` | Which lifecycle event to wait on: `turn-end`, `awaiting-input`, `exited`, `any`. |
| `--timeout <duration>` | `60s` / `15m` | Total wait budget. Duration string: `500ms`, `30s`, `5m`, `2h`. Bare integers under 1000 are rejected as ambiguous (`3000` → "did you mean 3000ms or 3s?"). Default is `60s` without `--until`, `15m` with `--until` (agent turns commonly run 5-20 minutes). |
| `--policy <policyId>` | — | Wait on a completion policy instead of a session event. Long-polls `GET /policies/:id/wait` until the policy leaves `watching`/`gating`/`queued`/`nudging`/`acting`. When set, the positional `<id-or-name>` is ignored. |
| `--json` | `false` | Machine-readable output. Suppresses the up-front "waiting up to…" banner; the matched result includes `timeoutMs` and `timeout` fields. |

Before blocking, the CLI prints its interpreted budget to stderr
(`waiting up to 5m (300000ms) for turn-end on ses_abc12…`) so a units
mistake is caught immediately — the incident this module exists for was a
`--timeout 3000` that was meant as 3000 seconds, not 3000ms.

#### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Condition met (session event matched, or policy reached `done`/`awaiting-ack`). |
| `2` | Timeout expired, usage error, or policy `blocked`/`cancelled`. |
| `3` | Session/policy not found, or daemon unreachable. |
| `4` | The matched turn-end was a silent no-op — `empty: true` (zero assistant output, zero tool calls) — or ended with `reason: "error"` (the adapter reported a failed turn). The wait DID resolve; the turn it resolved on produced nothing. Commonly a bad auth/model config. |

#### `status` vs `wait`

`agentproto sessions` (or `--json`) is a **non-blocking snapshot** — it
shows current state. `wait` **blocks** until a state transition occurs.
Use `wait` in scripts and supervisors; use the snapshot for dashboards
and humans.

#### When to use `wait` vs `session_monitor` (MCP)

| Surface | Max timeout | Multi-session | Use when |
|---------|-------------|---------------|----------|
| `sessions wait` (CLI) | Unlimited (chains calls) | No (one session) | You have a shell and want to script a gate or supervisor loop. |
| `session_monitor` (MCP) | 49s (MCP constraint) | Yes (up to 20) | You're an agent with MCP tools and need to fan-in across children. |

Both hit the same daemon endpoint (`GET /sessions/:id/wait`); the CLI
chains across the ~55s per-call ceiling, while `session_monitor`
multiplexes across sessions but is capped by MCP's own timeout.

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

### `queue <id-or-name>`

```bash
agentproto sessions queue ses_abc12
agentproto sessions queue claude-tui --json
agentproto sessions queue claude-tui --deliver 2
agentproto sessions queue claude-tui --drop 3
agentproto sessions queue claude-tui --force 2
```

Inspects — and optionally manipulates — the session's prompt FIFO. With no
action flag, lists what's queued: each item's position (`1` = next to
dispatch), origin (`user`/`agent`/`child`), preview, and `queuedAt`.

| Flag | Effect |
|------|--------|
| `--force <n>` | Jump position `n` to the **front** of the queue without touching the in-flight turn. |
| `--deliver <n>` | Interrupt whatever is running and dispatch position `n` now. |
| `--drop <n>` | Remove the item at position `n` without delivering it. |

Positions are 1-indexed, matching `sessions prompt` output. After any
action the queue is re-listed to show the result.

## Interrupting a live session

Use `agentproto sessions prompt <id> --prompt "..." --interrupt`, or call
the same capability through the MCP `agent_prompt` tool and the HTTP prompt
route:

```text
CLI:  agentproto sessions prompt <id-or-name> --prompt "..." --interrupt
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
| [`stop`](#stop-id-or-name) | Kills the process outright (SIGTERM). Conversation ends unless you [restart](#restarting-a-session). |
| [restart](#restarting-a-session) | Re-spawns from history, attempting to resume via the adapter's own session id — a new process, not a redirect of a live one. MCP tool / HTTP route / `--watch` `R` key only. |

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
