# Schedule an agent every morning

You want a recurring agent turn without starting it by hand: a weekday-morning
brief, a health check on a service, a check-in on a long-lived session.
`agentproto cron` registers a durable job on the daemon that fires on a 5-field
cron expression in local time: a fresh agent session, an allowlisted command,
or a re-prompt of a live session, every tick.

Status: Stable

## How it works

- Jobs persist to `~/.agentproto/cron-jobs.json` and survive daemon restarts.
- Exactly one action kind per job: `--adapter` spawns a brand-new agent session
  and prompts it, `--command` runs an allowlisted shell command, and
  `--target-session` re-prompts an existing, already-running session in place.
- Fires missed during downtime are not backfilled: after a restart a recurring
  job resumes from "now" rather than catching up on what it slept through.

Requires a running daemon ([`serve`](../verbs/serve.md) or
[`daemon`](../verbs/daemon.md)).

## Step 1: Add the job

```bash
agentproto cron add --schedule "0 9 * * 1-5" \
  --adapter claude-code \
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
| `--adapter <slug>` + `--prompt <text>` | Spawn a fresh agent session each fire. |
| `--command <cmd>` + `--args <arg>` | Run an allowlisted shell command (repeat `--args` for more). |
| `--target-session <id>` + `--prompt <text>` | Re-prompt a live session in place; no new session is spawned. |
| `--label <text>` | Human-readable name shown by `cron list`. |
| `--once` | Fire a single time, then deactivate (the job stays listed, inactive). |
| `--model <id>` / `--cwd <dir>` | Model override and working directory (agent kind). |
| `--options-json <json\|@file>` | Extra `agent_start` spawn fields (agent kind only). |
| `--timeout-ms <duration>` | Command timeout (command kind). Bare integer or explicit `ms` suffix; `s`/`m`/`h` are rejected. |

## Step 2: Check the schedule and past runs

```bash
agentproto cron list
```

Shows every job: label, schedule, recurring/one-shot, active/inactive, next
run, last run, and last result. Add `--json` for the machine-readable form.

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

## Routines (AIP-41): shipped, not activated

`ROUTINE.md` files ([AIP-41](https://agentproto.sh/docs)) exist as a second
scheduling surface: five ship inside `packages/` (session-steward,
repo-maintenance, worktree-gc, and friends). None are activated in practice:
every shipped and workspace routine is `enabled: false`, and there is no
`agentproto routine` verb (triggering is the `routine_trigger` MCP tool).
Status: Experimental. Cron is the scheduling primitive to use today.

## What it doesn't do

- No backfill: fires missed while the daemon was down are lost; the job
  resumes from "now" after a restart.
- No pause/resume verb: to stop a schedule temporarily, `cron remove` the job
  and re-add it later; `--once` covers the one-shot case.
- No per-run log page: `cron list` shows the last run and its result. For an
  agent-kind job, the turn it spawned is an ordinary session: inspect it with
  [`sessions`](../verbs/sessions.md) like any other.
- No workflow runs: a cron job fires a command, an agent turn, or a session
  prompt. To run a `WORKFLOW.md` on a schedule, point a command job at
  `agentproto workflow run-file` (the command must be allowlisted); see the
  [workflows guide](workflows.md).
