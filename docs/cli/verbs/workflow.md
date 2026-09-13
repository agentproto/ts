# `agentproto workflow`

```text
agentproto workflow start --workflow-id <label> --stages-json <json|@file>
                          [--cwd <dir>] [--workspace-slug <slug>]
                          [--notify-url <url>] [--cache-key <key>]
                          [--app-id <appId>] [--app-run-id <appRunId>]
                          [--item <item>] [--json]
agentproto workflow run-file <path>
                          [--input-json <json|@file>] [--cwd <dir>]
                          [--workspace-slug <slug>] [--cache-key <key>] [--json]
agentproto workflow status <runId> [--json]
agentproto workflow list   [--json]
agentproto workflow cancel <runId> [--json]
agentproto workflow resolve <runId> (--approve | --reject)
                            [--approval-id <id>] [--who <name>] [--note <text>]
                            [--json]
agentproto workflow resolve <runId> --payload-json <json|@file> [--json]
agentproto workflow resolve <runId> --stage-index <n> --step-index <n>
                            --response <text> [--json]
```

Start, inspect, and cancel background workflow **runs** on the daemon —
ordered stages of steps that spawn/reuse agent sessions, each stage's steps
running concurrently with a barrier gating the next stage. This is the shell
surface for the same WorkflowRunner the `workflow_start` / `workflow_run_file`
/ `workflow_status` / `workflow_list` / `workflow_cancel` /
`workflow_escalation_resolve` MCP tools drive. (App-bundle workflow
*authoring* lives under [`app.md`](./app.md) — this verb drives runs.)

Requires a running daemon ([`serve.md`](./serve.md) or
[`daemon.md`](./daemon.md)).

Every `<json|@file>` value is inline JSON or `@path` to read the JSON from a
file — the same convention as `sessions start --options-json` and
`policy attach --attach-json`.

## Subverbs

### `start`

Starts a run and returns its `runId` immediately — the workflow executes in
the background; poll with `workflow status`.

| Flag | Default | Description |
|------|---------|-------------|
| `--workflow-id <label>` | *(required)* | Arbitrary label for this workflow type. |
| `--stages-json <json\|@file>` | *(required)* | The `stages` array of the `workflow_start` input, verbatim. |
| `--cwd <dir>` | — | Working directory for spawned sessions. |
| `--workspace-slug <slug>` | — | Workspace slug passed to each spawned session. |
| `--notify-url <url>` | — | Webhook called on run completion or escalation. |
| `--cache-key <key>` | — | Enable journal caching; cacheable steps replay unchanged outputs on re-invocation. |
| `--app-id <appId>` | — | App provenance — the installed app this run belongs to. |
| `--app-run-id <appRunId>` | — | The app_run this run belongs to. |
| `--item <item>` | — | Ledger item stamped on every app-ledger event this run appends. |

```bash
agentproto workflow start --workflow-id review-then-fix --stages-json @stages.json
```

`start` rides the daemon's `/mcp` endpoint as the `workflow_start` MCP tool
(same client pair as [`mcp-bridge.md`](./mcp-bridge.md)) so the full input
schema — including `cacheKey`/`appId`/`appRunId`/`item`, which the REST
`POST /workflows` twin does not carry — is available from the shell.

### `run-file`

Load an AIP-15 `WORKFLOW.md` (+ optional `entry.mjs`) and run it through the
same runner as `start`. Rides `/mcp` as the `workflow_run_file` tool — the
daemon mounts no REST route for this form.

| Flag | Default | Description |
|------|---------|-------------|
| `<path>` | *(required)* | Absolute or workspace-relative path to the WORKFLOW.md. |
| `--input-json <json\|@file>` | — | Workflow invocation input, bound to `$input`. |
| `--cwd <dir>` | — | Working directory for spawned sessions. |
| `--workspace-slug <slug>` | — | Workspace slug for spawned sessions. |
| `--cache-key <key>` | — | Enable journal caching. |

### `status`

Poll a run via `GET /workflows/:id`. Prints run id, workflow id, status, and
a per-stage summary of each step's status and session id; flags
`awaitingApproval` / `awaitingSuspend` when the run is parked, with the
`resolve` invocation that answers each. `--json` prints the full run
record. Exit `3` when the run id doesn't exist.

### `list`

List all runs (running, awaiting-\*, done, failed, cancelled) via
`GET /workflows` — id, workflow id, status, start/end. `--json` prints the
full list.

### `cancel`

Cancel a run by explicit `<runId>` via `POST /workflows/:id/cancel`. Steps
already in flight finish; no new stages start. Same interaction model as
`policy cancel`: explicit id required, no interactive prompt. Exit `3` when
the run id doesn't exist.

### `resolve`

Answer a run parked on external input — the three forms of
`workflow_escalation_resolve`, mutually exclusive, exactly one per call.
Rides the daemon's `/mcp` endpoint (the REST escalation route only covers
the legacy escalate form).

| Form | Flags | Resolves |
|------|-------|----------|
| approval | `--approve` or `--reject` (+ optional `--approval-id <id>`, `--who <name>`, `--note <text>`) | A parked human approval (`approvalId` from `workflow status`'s `awaitingApproval`). `--who` defaults to "human". |
| suspend | `--payload-json <json\|@file>` | A run parked at a `kind:"suspend"` step — the payload resumes it. |
| escalate | `--stage-index <n>` + `--step-index <n>` + `--response <text>` | A step that escalated because its session asked for human input (0-based indices). |

```bash
agentproto workflow resolve wfrun_abc123 --approve --who jeremy
agentproto workflow resolve wfrun_abc123 --payload-json '{"resume": true}'
agentproto workflow resolve wfrun_abc123 --stage-index 1 --step-index 0 --response "yes"
```