# `agentproto task`

```text
agentproto task create <title> [--description <text>] [--board-id <boardId>]
                       [--owner <who>] [--blocked-by <taskId>]...
                       [--meta-json <json|@file>] [--verify-json <json|@file>] [--json]
agentproto task list   [--board-id <boardId>] [--status <status>] [--include-closed] [--json]
agentproto task claim  <taskId> --rev <n> [--json]
agentproto task update <taskId> --rev <n> [--status <status>] [--title <text>]
                       [--description <text>] [--blocked-by <taskId>]...
                       [--owner <who>] [--release] [--note <text>]
                       [--evidence-policy <policyId>] [--json]
```

Create and drive tasks on the daemon's Task ledger — the same ledger the
`task_create` / `task_list` / `task_claim` / `task_update` MCP tools and the
work-board kanban panel use. Thin HTTP client over the daemon's `/tasks`
REST routes; no new ledger behaviour.

Requires a running daemon ([`serve.md`](./serve.md) or
[`daemon.md`](./daemon.md)).

Every `<json|@file>` value is inline JSON or `@path` to read the JSON from a
file — the same convention as `sessions start --options-json` and
`policy attach --attach-json`.

## Boards — where a shell-created task lands

Board identity drives who sees a task. Over MCP, a caller's default board
resolves from its identity: a daemon session lands on its lineage board
(`tree:<root>`), the operator lands on the workspace board (`ws:<slug>`).
A shell invocation arrives as the **operator** (the `/tasks` REST routes act
in operator context — there is no session lineage to resolve a `tree:` board
from), so its default board is the operator's workspace board:
`ws:<active-workspace-slug>`, or `ws:default` when no workspace is active —
the same default an unscoped root-MCP `task_create` gets.

`task create` prints the board the task actually landed on, and `task list`
prints the resolved board in its header — the default is visible, never
silent. Scripts that must not depend on the daemon's workspace slug should
pass `--board-id <boardId>` explicitly. Lineage boards (`tree:*`) cannot be
reached from the shell without an explicit `--board-id`.

## Statuses

`pending | in_progress | done | failed | cancelled` — `pending ⇄
in_progress → done|failed`; `pending|in_progress → cancelled`; `done →
pending` is the explicit reopen.

## Subverbs

### `create`

| Flag | Default | Description |
|------|---------|-------------|
| `<title>` | *(required)* | One-line imperative title. |
| `--description <text>` | — | Longer context for whoever claims it. |
| `--board-id <boardId>` | operator's `ws:` board | Explicit board (see above). |
| `--owner <who>` | — | Pre-assign: a sessionId, `human`, or `operator`. Omit → claimable by anyone. |
| `--blocked-by <taskId>` | — | Repeatable. Task ids this depends on. Informational in v1 — nothing schedules off it. |
| `--verify-json <json\|@file>` | — | Opt-in done-gate (same shape as `policy attach`'s gate): shell command (exit 0 = pass) or judge agent. With it, `status:done` only lands after the gate passes. |
| `--meta-json <json\|@file>` | — | Free-form provenance (`prUrl`, `worktreePath`, …). |

Output prints the task id, board, status, and its initial **rev** — the
value to pass to `claim`/`update`.

### `list`

List tasks, OPEN only by default (`--include-closed` adds
done/failed/cancelled). Prints the resolved board in the header, then one
row per task: id, rev, status, owner, title. `--json` prints the full
records.

| Flag | Default | Description |
|------|---------|-------------|
| `--board-id <boardId>` | resolved default | Which board to list. |
| `--status <status>` | — | Filter to one status. |
| `--include-closed` | off | Include done/failed/cancelled. |

### `claim`

Claim a task — over REST the claim is `PATCH {rev, owner:"operator",
status:"in_progress"}` in operator context (the route's documented
convention; there is no separate claim route). A CLI process cannot claim
**as a session** — a claim from the shell always claims as the operator.
Unlike the MCP `task_claim` it may reassign an already-owned task (the
operator is a manager). `--rev` is required; a lost race prints the
conflict and the current record — rebase and retry with its rev.

```bash
agentproto task claim task_abc --rev 0
```

### `update`

Rev-CAS update: pass the `--rev` you last read; a mismatch answers a
conflict with the current record (retry with the current rev). `--rev` is
required — the ledger's rev-CAS is the mutation guard, so no interactive
prompt is added (that would break scripting).

| Flag | Applies to | Description |
|------|-----------|-------------|
| `--status <status>` | owner, or creator/operator for reopen/cancel | Target status (see above). |
| `--title <text>` | creator/operator | New title. |
| `--description <text>` | creator/operator | New description. |
| `--blocked-by <taskId>` | creator/operator | Replace the dependency list. |
| `--owner <who>` | creator/operator | Reassign. |
| `--release` | the owner (or creator/operator) | Clear the owner (`owner:null`). |
| `--evidence-policy <policyId>` | with `--status done` | Close off an already-PASSED completion policy — stamped verbatim, nothing re-runs. |
| `--note <text>` | anyone | Free-text note, stamped into `meta.note`. |

`--status done` on a task with a verify gate answers `verifying:true` —
the gate decides after the fact (green → done, red → stays in_progress).
`--release` and `--owner` are mutually exclusive.

