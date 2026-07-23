# `agentproto permissions`

```text
agentproto permissions ls        [--json] [--session <id>]
agentproto permissions approve   <id> [--always] [--option-id <id>] [--json]
agentproto permissions deny      <id> [--option-id <id>] [--json]
agentproto permissions watch     [--allow-tool <pat>]... [--deny-tool <pat>]...
                                 [--session <id>] [--rules-json <json|@file>]
                                 [--always] [--interval <dur>] [--timeout <dur>]
                                 [--once] [--dry-run] [--json]
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

### `watch`

```bash
agentproto permissions watch --allow-tool "Write"
agentproto permissions watch --deny-tool "Bash" --allow-tool "*"
agentproto permissions watch --rules-json @rules.json --once --dry-run
```

Polls the permission inbox and **auto-resolves** requests that match explicit
rules; anything that doesn't match stays parked for `permissions ls` / manual
`approve`/`deny`. There is no implicit "resolve everything" — you must supply at
least one rule.

Two rule forms:

| Form | Flags | Notes |
|------|-------|-------|
| Flag rules | `--allow-tool <pat>`, `--deny-tool <pat>`, optional `--session <id>`, optional `--always` | `--deny-tool` rules are evaluated **before** `--allow-tool` rules. Patterns are exact tool names or `*`-globs (e.g. `mcp__*`). |
| JSON rules | `--rules-json <json\|@file>` | Full rule array; mutually exclusive with the flag rules. |

A `--rules-json` rule looks like:

```json
[
  { "match": { "toolName": "ExitPlanMode", "sessionId": "s-abc" },
    "decision": "approve", "scope": "always" }
]
```

`match` needs at least one of `toolName` or `sessionId`; `sessionId` matches the
entry's session id **or** label. `decision` is `"approve"` or `"deny"`.
`optionId` and `scope` ( `"once"` or `"always"`, approve-only) are forwarded to
the daemon verbatim.

| Flag | Default | Description |
|------|---------|-------------|
| `--allow-tool <pat>` | — | Approve matching tools. Repeatable. |
| `--deny-tool <pat>` | — | Deny matching tools. Repeatable. Evaluated before allows. |
| `--session <id>` | — | Scope all flag rules to one session (id or label). |
| `--rules-json <json\|@file>` | — | Full rule array; cannot be combined with flag rules. |
| `--always` | `false` | With flag rules: prefer the agent's allow-always option when offered. |
| `--interval <dur>` | `2s` | Poll interval. Accepts `500ms`, `30s`, `5m`, `2h`; bare integer = ms. |
| `--timeout <dur>` | `1h` | Give up after this long. Same duration format. |
| `--once` | `false` | Run a single poll pass and exit. |
| `--dry-run` | `false` | Print what would be resolved without actually resolving. |
| `--json` | `false` | Emit one compact JSON object per line (NDJSON). |

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
