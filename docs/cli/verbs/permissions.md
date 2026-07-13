# `agentproto permissions`

```text
agentproto permissions ls        [--json] [--session <id>]
agentproto permissions approve   <id> [--always] [--option-id <id>] [--json]
agentproto permissions deny      <id> [--option-id <id>] [--json]
```

The human side of the **cross-session permission inbox**. A session started
in *permission-hold mode* parks each tool-permission request the agent raises
(Write, Bash, …) instead of auto-answering it; this verb lists every parked
request across all sessions and approves or denies one, unblocking the agent.

Requires a running daemon ([`serve.md`](./serve.md) or [`daemon.md`](./daemon.md)).

## Starting a session that holds

Permission-hold is opt-in at spawn time — the default is unchanged
(requests are auto-answered so the turn never blocks):

```bash
# CLI (daemon-backed)
agentproto sessions start claude-code --workspace my-app --hold-permissions

# MCP
agent_start { "adapter": "claude-code", "permissionHold": true }

# HTTP
POST /sessions/agent   { "adapter": "claude-code", "permissionHold": true }
```

Held sessions render with a `!` badge in `agentproto sessions --watch`.
ACP adapters only (e.g. claude-code); adapters with no permission surface
ignore the flag.

## Discovery

Discovers the daemon via `<workspace>/.agentproto/runtime.json` (same as
[`sessions.md`](./sessions.md)). The token there is sent as Bearer on the
mutating `approve`/`deny` routes; `ls` is read-only. Override with
`AGENTPROTO_DAEMON_URL` / `AGENTPROTO_DAEMON_TOKEN`.

## Subverbs

### `ls`

```bash
agentproto permissions ls
agentproto permissions ls --json
agentproto permissions ls --session ses_abc123
```

GETs `/permissions`. Lists everything currently held, oldest first:

```text
ID          SESSION         TOOL                AGE    QUESTION
perm_1      ses_abc123      Write               12s    Allow "Write"?
perm_2      ses_def456      Bash                3s     Allow "Bash"?
```

`--json` emits the full records (id, sessionId, toolCallId, toolName, text,
options, requestedAt, plus the owning session's adapter/title and age).
`--session <id>` filters to one session.

### `approve <id>`

```bash
agentproto permissions approve perm_1              # allow-once
agentproto permissions approve perm_1 --always     # allow-always, if offered
agentproto permissions approve perm_1 --option-id allow_edits
```

POSTs `/permissions/:id` with `{ decision: "approve" }`. Selects an
allow-flavored option — allow-once by default, or allow-always when the
request offers one and `--always` is passed. `--option-id` picks an exact
offered option, overriding the decision→option mapping. The agent's turn
resumes with the granted tool call.

### `deny <id>`

```bash
agentproto permissions deny perm_2
```

POSTs `/permissions/:id` with `{ decision: "deny" }`. Selects a
reject-flavored option, or cancels the request outright when none is offered.
The tool call fails cleanly and the agent keeps reasoning.

## Errors

- Unknown or already-resolved id → exit `1` with `HTTP 404`.
- An `approve` on a request that offers no allow-flavored option (and no
  `--option-id`) → `HTTP 409` — pass an explicit `--option-id` from
  `ls --json`.

## Equivalent surfaces

The inbox is one shared registry behind three transports:

| | List | Respond |
|--|--|--|
| CLI | `permissions ls` | `permissions approve\|deny` |
| MCP | `permissions_list` | `permissions_respond` |
| HTTP | `GET /permissions` | `POST /permissions/:id` |

The bus also emits `session:permission-request` / `session:permission-resolved`
events, visible through `session_events_poll` / `session_monitor` and
per-session webhooks.

## See also

- [`sessions.md`](./sessions.md) — `--hold-permissions` and the `!` badge
- [Roles](../concepts/roles.md) — the spawn-time delegation gate, a
  different (spawn-time) permission boundary than this (per-tool) one
