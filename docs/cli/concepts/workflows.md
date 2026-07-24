# Workflows

A **workflow** is an ordered list of **stages**. Each stage is a group of
**steps** that spawn (or reuse) an agent session and run **concurrently**. An
explicit **barrier** gates the next stage: stage N+1 does not start until every
step of stage N has finished (or failed).

It is the `parallel()` half of a harness-style orchestration primitive. The
daemon exposes it as the `workflow_start` / `workflow_status` MCP tools — there
is no `agentproto workflow` verb; you drive it from any MCP client (a coding CLI,
another agent, your own code) against a running [`serve`](../verbs/serve.md)
daemon.

```
  stage 1                    barrier            stage 2
 ┌──────────────┐              │             ┌──────────────┐
 │ step ┃  step │  all done ───┼─── start ──▶│ step ┃  step │
 │ (run parallel)              │             │  may reuse a stage-1
 └──────────────┘              │             │  session via sessionRef
                               │             └──────────────┘
```

## Starting a workflow

`workflow_start` returns a `runId` immediately and runs in the background; poll
with `workflow_status`.

```jsonc
// workflow_start
{
  "workflowId": "review-then-fix",
  "stages": [
    {
      "label": "review",
      "steps": [
        { "label": "review-auth",  "adapter": "claude-code", "prompt": "Review auth.ts for bugs." },
        { "label": "review-db",    "adapter": "claude-code", "prompt": "Review db.ts for bugs." }
      ]
    },
    {
      "label": "fix",
      "steps": [
        // reuse the reviewer's session so the fixer sees its findings:
        { "label": "fix-auth", "sessionRef": "review-auth", "prompt": "Now fix what you found." }
      ]
    }
  ]
}
```

- **`adapter`** spawns a new session for the step; **`sessionRef`** reuses the
  session a prior step (any earlier stage) spawned, by that step's `label` —
  how a later stage acts on an earlier stage's output.
- **`policy`** decides what happens if a step's session asks for input
  mid-stage: `auto-allow` (send a canned prompt), `escalate` (webhook + timeout),
  or `fail`.
- **`notifyUrl`** fires a webhook on completion or escalation.

`workflow_status` reports each stage's steps with their `status` and `sessionId`,
so later work can inspect what a stage produced (e.g. `agent_output` on that
`sessionId`).

## Run a WORKFLOW.md file

The daemon also exposes `workflow_run_file`, which loads an AIP-15
`WORKFLOW.md` (plus optional `entry.mjs`) via the workflow loader and
runs it through the same engine as `workflow_start`. Poll the returned
`runId` with `workflow_status`.

| Parameter | Meaning |
| --------- | ------- |
| `path` | Absolute or workspace-relative path to the `WORKFLOW.md` file. |
| `input` | Optional invocation input, bound to `$input` in the compiled workflow. |
| `cwd` / `workspaceSlug` | Passed to spawned sessions. |
| `cacheKey` | Enables journal caching for the run. |

## Which primitive?

| Use | Shape |
| --- | --- |
| **`workflow_start`** | Stages of **parallel** steps with a **barrier** between stages. A flat sequential list is just a workflow of single-step stages. |
| [**`run-swarm`**](../verbs/run-swarm.md) | A **kernel-driven loop** — a dispatcher picks who speaks each turn over a shared conversation substrate. |

Reach for a workflow when the work is a fixed DAG of stages (a straight
sequence included — single-step stages, no barrier to wait on); a swarm when
turn-taking is dynamic and conversation-driven.

> `routine_start`/`routine_status`/`routine_cancel`/`routine_escalation_resolve`
> (and the mirroring `/routines/*` REST run routes) have been **removed** —
> use `workflow_start` with single-step stages instead. `routine_list` /
> `routine_trigger` / `routine_reconcile` are a different, unrelated
> primitive (AIP-41 `.routines/*` scheduled routine definitions) and are
> unaffected.

## Resume cache

A workflow run can **journal** its steps so a re-run replays unchanged work
instead of re-spawning sessions. Pass a **`cacheKey`** on the run and mark the
idempotent steps **`cacheable: true`**:

```jsonc
{
  "workflowId": "nightly-audit",
  "cacheKey": "nightly-audit",           // enables the journal for this run
  "stages": [
    { "steps": [
      { "label": "scan", "adapter": "claude-code",
        "prompt": "Summarize the changelog since the last tag.",
        "cacheable": true }                // idempotent → safe to replay
    ] }
  ]
}
```

On the next `workflow_start` with the **same `cacheKey`**, any `cacheable` step
whose resolved inputs (prompt + adapter + `sessionRef`) are unchanged replays its
journaled output — no session spawn, no cost. The journal is file-backed under
`~/.agentproto/workflow-cache/`. Only mark steps `cacheable` when re-running them
would be wasteful rather than wrong; most agent steps have side effects and
should stay uncached.

## The engine underneath

`workflow_start` translates onto one execution engine,
[`@agentproto/workflow-runtime`](https://github.com/agentproto/ts/blob/main/packages/workflow-runtime/README.md)
— a typed step algebra (`tool`, `agent`, `pipeline`, `map`, `branch`, `loop`,
`parallel`, `approval`, `suspend`, `subworkflow`, …) walked by a single
interpreter. The MCP surface exposes the agent-session **stage/barrier** subset
plus **resume-cache**. When you **embed** the engine directly you also get:

- **`pipeline`** — N items through K stages with **no cross-item barrier** (each
  item flows independently; wall-clock = slowest single chain).
- **structured output** — validate an agent step's final message against a schema
  and **re-prompt on mismatch**.
- **aggregate budget** — `maxTotalCostUsd` caps summed session cost across the
  run; the next spawn past the cap fails `budget_exceeded`.

See the package README for the embedding API and examples.
