# Schedule an agent every morning

You want a recurring agent turn without starting it by hand: a weekday-morning
brief, a health check on a service, a check-in on a long-lived session.
`agentproto cron` registers a durable job on the daemon that fires on a 5-field
cron expression in local time: a fresh agent session, an allowlisted command,
or a re-prompt of a live session, every tick.

Status: Stable

## How it works

- Jobs persist to `~/.agentproto/cron-jobs.json` and survive daemon restarts.
- Exactly one action kind per job: `--harness` spawns a brand-new agent session
  and prompts it, `--command` runs an allowlisted shell command, and
  `--target-session` re-prompts an existing session in place (a session id, or
  `agent:<label>` resolved to a session at fire time).
- Each job records `createdBy` (operator, system, external, or a session with
  `proven` or `claimed` proof), frozen at creation. The operator caller is
  `{ kind: "operator" }`. `createdBy` is distinct from `ownedBy` (lifetime);
  a fired job still runs as the operator and is not clamped by its creator yet.
  A job created before this change shows no `createdBy`.
- Fires missed during downtime are not backfilled: after a restart a recurring
  job resumes from "now" rather than catching up on what it slept through.

Requires a running daemon ([`serve`](../verbs/serve.md) or
[`daemon`](../verbs/daemon.md)).

## Step 1: Add the job

```bash
agentproto cron add --schedule "0 9 * * 1-5" \
  --harness claude-code \
  --prompt "Summarize what changed in this repo since yesterday and flag anything that needs me." \
  --label "morning-brief"
```

`--schedule` is required: a 5-field cron expression in local time
(`minute hour day-of-month month day-of-week`, day-of-week 0-7 with 0=Sunday).
The command prints the job id, schedule, recurrence, and next run.

The flags you will actually touch (verified against `cron add --help`):

| Flag | What it does |
|------|--------------|
| `--schedule <expr>` | Required. 5-field cron expression, local time. |
| `--harness <slug>` + `--prompt <text>` (`--adapter` is a deprecated alias) | Spawn a fresh agent session each fire. |
| `--command <cmd>` + `--args <arg>` | Run an allowlisted shell command (repeat `--args` for more). |
| `--target-session <id>` + `--prompt <text>` | Re-prompt a session in place (id or `agent:<label>`); no new session is spawned. |
| `--label <text>` | Human-readable name shown by `cron list`. |
| `--notify <mode>` | How loudly a successful command run is heard: `always` (default) wakes followers, `onFailure` sends success to their inbox as `fyi`. |
| `--once` | Fire a single time, then deactivate (the job stays listed, inactive). |
| `--model <id>` / `--cwd <dir>` | Model override and working directory (agent kind). |
| `--options-json <json\|@file>` | Extra `agent_start` spawn fields (agent kind only). |
| `--timeout-ms <duration>` | Command timeout (command kind). Bare integer or explicit `ms` suffix; `s`/`m`/`h` are rejected. |

## Step 2: Check the schedule and past runs

```bash
agentproto cron list
```

Shows every job: label, schedule, recurring/one-shot, active/inactive, notify
mode, next run, last run, and last result. Add `--json` for the machine-readable
form.

## Step 3: Fire one now (optional)

```bash
agentproto cron run <id>
```

A manual fire is the same fire the scheduler would have run, not a rehearsal:
it records `lastResult`, and on a `--once` job it consumes the single fire.

## Step 4: Remove it

```bash
agentproto cron remove <id>
```

(`delete` and `rm` are aliases.)

## Routines (AIP-41): compiled to cron jobs

`ROUTINE.md` files ([AIP-41](https://agentproto.sh/docs)) are a declarative way
to write a cron job. At daemon boot, the routine registrar scans
`<workspace>/.routines/<id>/ROUTINE.md` and, for every routine that is
`enabled: true` with a cron schedule, registers (or updates) an ordinary cron
job labelled `routine:<id>`. From there it is a normal job: it shows in
`cron list`, records runs, and can be paused with `cron_update`. A routine with
`enabled: false` is not registered. The routines shipped inside `packages/`
(session-steward, repo-maintenance, worktree-gc, and friends) ship with
`enabled: false`; a workspace turns one on by providing its own enabled
`ROUTINE.md`.

There is no `agentproto routine` verb. The `routine_list`, `routine_reconcile`
and `routine_trigger` MCP tools cover listing, re-scanning and firing one now
(a trigger bypasses both the schedule and `enabled`).

## Pausing and resuming

There is no CLI verb for it, but the `cron_update` MCP tool pauses and resumes
any job (routine-backed or not): `active: false` pauses, `active: true`
resumes. A resume also clears the failure counter and any `pausedReason`.

A job that keeps failing pauses itself. After 2 consecutive non-productive runs
(`maxConsecutiveFailures` on the job overrides the default) the scheduler sets
`active` to false, records a `pausedReason`, and emits `cron:unhealthy`. Fix the
cause, then resume it with `cron_update`.

## What it doesn't do

- No backfill: fires missed while the daemon was down are lost; the job
  resumes from "now" after a restart.
- No pause/resume CLI verb: use the `cron_update` MCP tool (`active`), see
  [Pausing and resuming](#pausing-and-resuming), or `cron remove` and re-add.
- No per-run log page: `cron list` shows the last run and its result. For an
  agent-kind job, the turn it spawned is an ordinary session: inspect it with
  [`sessions`](../verbs/sessions.md) like any other.
- No workflow runs: a cron job fires a command, an agent turn, or a session
  prompt. To run a `WORKFLOW.md` on a schedule, point a command job at
  `agentproto workflow run-file` (the command must be allowlisted); see the
  [workflows guide](workflows.md).
