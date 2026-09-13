---
name: ap-tasks
description: Use the agentproto shared task board — task_create, task_claim (CAS with rev), task_list, and task_update to coordinate parallel agents on one board, gate done with verify commands, and hand off work claimably. Trigger when coordinating parallel agents, splitting work across sessions, handing off tasks, or needing verifiable completion.
---

# ap-tasks

## When to use

- Several agents (or you + an agent) must share a list of work units without stepping on each other.
- You want "done" to be provable, not self-reported.
- You are handing a task to an unclaimed queue that any session on the board can pick up.

## Create tasks

```json
task_create({
  "title": "Migrate auth module to new API",
  "description": "Files under src/auth/. Keep test coverage. See plan.md section 3.",
  "owner": "self",
  "verify": { "command": "pnpm", "args": ["test", "auth"], "cwd": "/repo" }
})
```

`title` is required; `description` is for whoever claims it. Leave `owner` absent to make the task **claimable** — anyone on the board can pick it up. `boardId` defaults to your session's lineage board (`tree:<root>`) or the workspace board (`ws:<slug>`). The optional `verify` gate (a shell command, exit 0 = pass) makes `done` gated.

## The claim cycle: read → claim → work → update

Every task carries a `rev` (revision number). `task_claim` is compare-and-swap: it succeeds only if the task is `pending`, has **no owner**, and the `rev` you pass matches what you last read.

```json
// 1. List open tasks
task_list({ "boardId": "ws:studio" })

// 2. Claim before touching anything
task_claim({ "taskId": "task_7", "rev": 3 })
//    → ok, you own it, status flips to in_progress

// 3. Do the work, then close it
task_update({ "taskId": "task_7", "rev": 4, "status": "done", "note": "Migrated, 12 tests green" })

// 4. Dropping without finishing
task_update({ "taskId": "task_7", "rev": 5, "owner": null, "status": "pending" })
```

**ALWAYS claim before working and update when done.** Unclaimed work is invisible to the rest of the board; work you never close blocks everyone downstream.

## Conflicts

On a lost race, `task_claim` returns `{ "conflict": true, "current": {...} }` — someone moved first. Re-read `current`, then either pick a different task or retry the claim with the fresh `rev`. Never force: there is no override for a rev mismatch, and silently overwriting another agent's claim corrupts the board.

## Verify gates

When a task was created with `verify`, `status: "done"` does not close it immediately — the reply carries `verifying: true` and the gate runs after your turn ends. Green → done; red → the task stays `in_progress` with the failure in `lastVerifyError`. If you already have a passed completion policy for this work, close cheaply with `evidence: { "policyId": "..." }` — the gate is stamped, nothing re-runs.

## Gotchas

- Claim is CAS on `(taskId, rev)` — a rev mismatch means someone moved first. Re-read and re-claim; do not assume your claim landed.
- Boards are scoped: your session sees its lineage `tree:<root>` by default; the shared pool usually lives on `ws:<slug>`. Pass `boardId` explicitly when coordinating across sessions.
- `status: "done"` on a verify-gated task is a *claim that must prove itself* — it is not closed until the gate passes.
- `blockedBy` dependencies are informational only in v1; nothing schedules off them. Sequence work yourself.
- Closed tasks disappear from `task_list` by default — pass `includeClosed: true` (or a `status` filter) to see them.

## Pointers

- agentproto — daemon overview and board concepts.
- ap-spawn-agent — spawn the executors that will claim these tasks.
- pb-supervise-parallel-mission — packaged pattern: decompose into a board, fan out claimers.
- ap-wait-fanin — wait for several claiming agents to finish.
- ap-policies — completion policies that can double as verify gates.
