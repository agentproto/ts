# Your first supervised run: one supervisor, ten workers

Status: Stable (the Work Board section is Beta)

You have a job that splits into ten independent pieces, and you don't want to
open ten terminals and babysit each one. This guide shows how to start one
**supervisor** session that spawns ten **worker** sessions, collects their
reports, and lets you steer, track and clean up the whole fleet from one place.

Fan-out like this is used daily, with supervisors driving up to 22 children.

## Prerequisites

- `@agentproto/cli` installed and a running daemon (`agentproto serve`, or
  [`agentproto daemon`](../verbs/daemon.md) for a background service).
- At least one coding-agent adapter installed (for example `claude-code`), see
  [adapters](../concepts/adapters.md).
- A git repository, if you want each worker to get its own worktree.

## 1. Start the supervisor

A supervisor is a normal agent session that is allowed to spawn other
sessions. It does that through the daemon's MCP tools, so it needs the scoped
orchestrator gateway mounted. The CLI flag for that is `--orchestrator-json`:

```bash
agentproto sessions start claude-code \
  --cwd ~/code/my-project \
  --orchestrator-json '{"maxChildren": 12}' \
  --prompt "Split the migration into 10 independent pieces. Spawn one worker per piece with agent_start (role executor, wait false, worktree true). Then wait for them with inbox_wait until pendingChildren is empty. Do not end your turn before that."
```

Two limits apply to the supervisor's gateway:

- `maxChildren` is the cap on children alive at once. It defaults to **8**, so
  for ten workers raise it, as above.
- `maxDepth` (default 3, hard ceiling 8) bounds how many levels of
  supervisors-of-supervisors can grow.

Add `--attach` to watch the supervisor's terminal, or follow it later with
`agentproto sessions board` (see [`sessions`](../verbs/sessions.md)).

### Roles: who may delegate

A **role** decides whether a session may spawn further sessions. There are two
built-in roles (full details in [roles](../concepts/roles.md)):

| Role | May delegate? | Meant for |
|------|---------------|-----------|
| `supervisor` | yes | Decompose, delegate, verify. |
| `executor` | no | A leaf worker: do the task itself, spawn nothing. |

An `executor` cannot spawn anything, not even another executor. A
`supervisor` may spawn either.

There is **no `--role` flag** on `agentproto sessions start` today. Roles are
set with the `role` field of the `agent_start` MCP tool (or the same field on
the `POST /sessions/agent` HTTP body). If you leave it out, the role is derived
from depth: a session you start from the CLI is a `supervisor`, and sessions
spawned through a supervisor's gateway default to `executor`. Setting
`role: "executor"` explicitly on every worker is still the clearest choice.

### Spawn the workers

Inside its turn, the supervisor calls `agent_start` once per worker:

```json
{
  "adapter": "claude-code",
  "role": "executor",
  "wait": false,
  "worktree": true,
  "label": "worker-03",
  "prompt": "Migrate packages/billing to the new client. Open a PR when green, then report done to your parent."
}
```

- `role: "executor"` makes the worker a leaf.
- `wait: false` returns as soon as the child is spawned. Keep it `false` for a
  fan-out: with `wait: true` each call blocks until that child's whole first
  turn is over, and an agent that runs its tool calls one at a time ends up
  starting the workers one after another instead of in parallel.
- `worktree: true` gives the worker its own git worktree so ten agents don't
  edit the same checkout. The CLI twin on a single spawn is `--worktree`.

You can also start workers yourself from the shell, one command each:

```bash
agentproto sessions start claude-code --worktree --label worker-03 \
  --prompt "Migrate packages/billing ..."
```

Workers started this way have no supervisor parent, so they can't report up
with `message_parent`. Use this form for independent sessions, and let a
supervisor spawn the ones that need to report back.

## 2. Workers report back, the supervisor waits

A worker reports to its parent with the `message_parent` MCP tool. It needs no
session id, the daemon knows who the parent is. Each message has a kind:

| Kind | Use |
|------|-----|
| `report` | A result or progress update (default). |
| `question` | The worker needs an answer. |
| `blocker` | The worker cannot proceed. |
| `done` | The task is complete. |

The supervisor must not end its turn to "wait": an idle session is not woken
by a timer. Instead it loops on `inbox_wait`, which returns as soon as a child
reports:

```text
inbox_wait { from: "children", kind: ["done", "blocker", "question"], timeoutMs: 45000 }
  -> handle each message (message_reply to answer a question or blocker)
  -> repeat until pendingChildren is empty
```

`timeoutMs` is capped at 49 seconds per call, so the supervisor calls it in a
loop. The full tool list (`message_send`, `message_reply`, `inbox_list`,
`inbox_ack`) is in
[Messages between sessions](../verbs/sessions.md#messages-between-sessions).

## 3. Message a session yourself

You are a sender too. To nudge or redirect any session from the shell:

```bash
agentproto sessions message ses_abc12 "use the v2 client, not v1" --urgency steer
agentproto sessions inbox ses_abc12
```

`--urgency` controls how loudly the message lands:

| Urgency | Effect |
|---------|--------|
| `fyi` | Goes to the inbox only, no wake-up. |
| `next-turn` | Delivered as the session's next turn. |
| `steer` | Injected into the running turn when the agent supports steering, else next turn. |
| `interrupt` | Cancels the running turn and delivers now. Humans always have this; agents only if you allow it. |

`--kind` is one of `report` (default), `question`, `blocker`, `done`,
`notice`. Without `--urgency`, blockers and questions default to `steer`, the
rest to `next-turn`.

`sessions inbox` lists the messages a session hasn't consumed yet, with sender,
kind and urgency; `--ack <id,...|all>` removes them. The inbox is part of the
session's own state, bounded to the 200 most recent messages, and the full
history stays in the session's transcript. Sender identity is attested by the
daemon, so a worker can't forge a message "from you". Flags and the exact
delivery rules are in [`sessions`](../verbs/sessions.md).

## 4. Track who owns what (Work Board: Beta)

Ten workers means ten answers to "who is doing what". Two tools help:

- **The task ledger.** Create one task per piece and let each worker claim
  its own, so ownership is recorded instead of living in the supervisor's
  head:

  ```bash
  agentproto task create "Migrate packages/billing" --owner ses_abc12
  agentproto task list
  ```

  Workers can use the `task_create`, `task_list`, `task_claim` and
  `task_update` MCP tools against the same ledger. See
  [`task`](../verbs/task.md) for boards, statuses and the rev-based updates.

- **The Work Board (Beta).** In VS Code, run the command
  **agentproto: Open Work Board** (`agentproto.openWorkBoard`). It shows the
  ledger as a kanban: Unclaimed, In progress, Done, Failed, with per-card
  buttons (Claim, Start, Done, Fail, Release, Cancel, Reopen). Beta limits:
  there is no drag and drop, and it is VS Code only, not in the web panel and
  not a CLI verb.

## 5. Clean up

When the workers are done, their sessions and worktrees keep using RAM and
disk.

**Idle sessions: the steward.** [`agentproto steward`](../verbs/steward.md)
finds idle sessions and wraps them up. It is a **dry run by default**: it
prints what it would do and touches nothing.

```bash
agentproto steward --wait            # plan and verdicts only
agentproto steward --apply --wait    # close the confident ones
```

It never touches the session that runs it, and re-checks every session right
before acting.

**Worktrees.** Each `worktree: true` worker leaves a git worktree behind:

```bash
agentproto worktree ls --status      # what exists and what is safe to reclaim
agentproto worktree gc               # dry run: classify reclaim / salvage / hold
agentproto worktree gc --apply       # remove the reclaimable ones
agentproto worktree rm <path|slug>   # remove one, refuses if it has uncommitted work
```

`gc` only removes worktrees that are merged or fresh, clean and idle; anything
with uncommitted work is held. `worktree rm` refuses a dirty tree unless you
pass `--discard-modified` or `--discard-untracked`, and `worktree archive`
snapshots uncommitted work before removing. See
[`worktree`](../verbs/worktree.md).

## What it doesn't do

- **No `--role` on the CLI.** Roles are set through the `agent_start` MCP tool
  or the HTTP body, or derived from depth.
- **Executors can't be made to delegate**, and a role's delegation limit is a
  spawn-time default rather than a sandbox: the daemon cannot remove a native
  subagent tool that the coding CLI brings with it. The built-in roles tell
  the agent not to use it, which is a prompt rule, not enforcement. See
  [roles](../concepts/roles.md#how-the-delegation-gate-works).
- **Nothing wakes an idle supervisor on a timer.** If it ends its turn, it
  stays idle until a message or prompt arrives. Keep it in the `inbox_wait`
  loop.
- **Default of 8 live children.** Raise `maxChildren` for bigger fan-outs.
- **No merge of the workers' output.** Each worker's work lives in its own
  worktree and branch; combining or merging it is up to the supervisor or you.
- **Work Board (Beta):** no drag and drop, VS Code only.
- **The steward and `worktree gc` are cleanup, not scheduling.** They run when
  you run them (or when you schedule them yourself), and they never act
  without `--apply`.
