# Chain review and fix with a workflow

You want two or more agent turns chained: a reviewer finds bugs, then a fixer
reuses the reviewer's session to act on its findings, with a human approval
step in the middle. A `WORKFLOW.md` file declares the steps;
`agentproto workflow` runs it on the daemon and parks it when a step needs
your decision.

Status: Stable

## How it works

A workflow is an ordered list of stages; each stage's steps run concurrently,
and a barrier gates the next stage ([concepts/workflows.md](../concepts/workflows.md)).
A step can spawn a fresh session (`adapter`), reuse an earlier step's session
(`sessionRef`), call a tool, run a command, or park for a human decision
(`kind: approval`). A run returns its `runId` immediately and executes in the
background; poll it with `workflow status`.

Requires a running daemon ([`serve`](../verbs/serve.md) or
[`daemon`](../verbs/daemon.md)).

## Step 1: Pick or write a WORKFLOW.md

The repo ships working examples under `.github/agentproto-workflows/`
(`pr-review`, `review-fix-demo`, `security-fix`, `docs-audit`, and more):

```bash
rg --files -g "WORKFLOW.md" .github/agentproto-workflows
```

Each is a directory with a `WORKFLOW.md` (the manifest: name, id, version,
steps) plus, for `agent` steps, an `entry.mjs` beside it that holds the prompts.
`review-fix-demo` is the review-then-fix reference: a `review` step spawns a
`claude-code` session, and the `fix-and-pr` step reuses that same session via
`sessionRef`, so the fix sees the review findings. Copy the directory and edit
the prompts to make it yours.

## Step 2: Run it

```bash
agentproto workflow run-file .github/agentproto-workflows/review-fix-demo/WORKFLOW.md
```

`run-file` loads the `WORKFLOW.md` (plus its optional `entry.mjs`) and starts
a run. To start a run from stages JSON instead of a file:

```bash
agentproto workflow start --workflow-id review-then-fix --stages-json @stages.json
```

Both return a `runId` immediately; the run executes in the background.

## Step 3: Add a human approval step

Add a `kind: approval` step to the manifest:

```yaml
  - id: signoff
    kind: approval
    prompt: Apply the fix?
    approvers:
      - role: maintainer
    timeout_ms: 600000
```

In a workflow that has an `entry.mjs` (like `review-fix-demo`), the entry is
the source of truth for `agent` steps and the manifest only mirrors the step
graph, so put the approval in the entry's step graph as well. Alternatively,
skip the file: `workflow start` accepts `approval` as a step kind in its
stages JSON.

The run parks at that step instead of continuing. `workflow status <runId>`
flags the run `awaitingApproval` and prints the `resolve` invocation that
answers it.

## Step 4: Approve it

```bash
agentproto workflow resolve <runId> --approve --who jeremy
```

`--approve` resumes the run on the approve branch, `--reject` takes the reject
branch, and `--note <text>` attaches a comment. `--who` defaults to "human".

## Step 5: Inspect runs

```bash
agentproto workflow status <runId>
agentproto workflow list
```

`status` prints each stage's steps with their status and session id (add
`--json` for the full run record); `list` shows every run with its status and
timestamps. `workflow cancel <runId>` stops a run: in-flight steps finish, no
new stages start.

## What it doesn't do

- No dynamic turn-taking: the step graph is fixed at author time. When the
  dispatcher should decide who speaks each turn over a shared conversation,
  use [run-swarm](../verbs/run-swarm.md) instead.
- No foreground mode: a run returns its `runId` immediately and executes in
  the background; poll with `workflow status`.
- No scheduling of its own: a workflow runs when you run it. To fire one on a
  schedule, see the [cron guide](cron.md).
