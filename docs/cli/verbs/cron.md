# `agentproto cron`

```text
agentproto cron add --schedule <cron-expr>
                    (--command <cmd> [--args <arg>...] [--cwd <dir>] [--timeout-ms <duration>]
                     | --adapter <slug> --prompt <text> [--cwd <dir>] [--model <id>]
                     | --target-session <id> --prompt <text>)
                    [--label <text>] [--once] [--json]
agentproto cron list   [--json]
agentproto cron remove <id>                    (aliases: delete, rm)
agentproto cron run    <id> [--json]
```

`--timeout-ms` accepts a duration string. Because the flag name already declares
milliseconds, the value must be a bare integer or carry an `ms` suffix (`30s`
and `5m` are rejected).

Manage durable cron jobs on the daemon — run a command, spawn an agent, or
re-prompt a live session on a schedule. Jobs persist to
`~/.agentproto/cron-jobs.json` and survive daemon restarts.

Requires a running daemon ([`serve.md`](./serve.md) or
[`daemon.md`](./daemon.md)); the verb drives the `/cron` HTTP routes.

**Fires missed during downtime are not backfilled.** A recurring job resumes
from "now" after a restart rather than catching up on what it slept through.

## Schedule

A 5-field cron expression in **local time**:

```text
minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-7, 0=Sun)
```

Jobs recur indefinitely by default. `--once` fires a single time, then
deactivates the job (it stays listed, inactive).

## Action kinds

Exactly one per job — `--command`, `--adapter`, and `--target-session` are
mutually exclusive, and passing none or more than one exits `2`.

| Kind | Flag | What it does |
|------|------|--------------|
| Command | `--command <cmd>` | Runs an allowlisted shell command. Must be listed in `<workspace>/.agentproto/allowed-commands.json`. |
| Agent | `--adapter <slug>` | Spawns a **brand-new** agent session and prompts it. Requires `--prompt`. |
| Prompt-session | `--target-session <id>` | Re-prompts an existing, already-running session **in place** — no new session is spawned. Requires `--prompt`. For a durable session a job checks in on periodically. |

## Subverbs

### `add`

Creates a job via `POST /cron` and prints its id, schedule, recurrence, and
next run.

| Flag | Default | Description |
|------|---------|-------------|
| `--schedule <cron-expr>` | *(required)* | 5-field expression, local time. |
| `--command <cmd>` | — | Allowlisted command to run. |
| `--args <arg>` | — | Argument for `--command`; repeatable. |
| `--adapter <slug>` | — | Adapter to spawn a fresh session from. |
| `--target-session <id>` | — | Live session to re-prompt in place. |
| `--prompt <text>` | — | The turn to send. Required with `--adapter` or `--target-session`. |
| `--cwd <dir>` | — | Working dir (command and agent kinds). |
| `--model <id>` | — | Model override (agent kind). |
| `--timeout-ms <duration>` | — | Command timeout (command kind). Bare integer or explicit `ms` suffix only; `s`/`m`/`h` are rejected because the flag name already declares milliseconds. |
| `--label <text>` | — | Human-readable label, shown by `list`. |
| `--once` | `false` | Fire once, then deactivate. |
| `--json` | `false` | Emit the created job as JSON. |

### `list`

Lists every job via `GET /cron` — label, schedule, recurring/one-shot,
active/inactive, next run, last run, and last result.

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Emit `{"jobs":[…]}` as JSON. |

### `remove <id>`

Deletes a job via `DELETE /cron/:id`. Accepts `delete` and `rm` as aliases.

### `run <id>`

Fires a job **now** via `POST /cron/:id/run`, out of band, and reports the
result.

A manual fire is the *same* fire the scheduler would have run, not a rehearsal:
it records `lastResult`, and on a `--once` job it **consumes the single fire**
— the job deactivates just as if its schedule had come round. A recurring job's
`nextRunAt` is recomputed from its expression, so its cadence is unchanged.

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Emit the full run result as JSON. |

## Examples

```bash
# One-shot smoke test a minute from now
agentproto cron add --schedule "* * * * *" --command echo --args hello --once

# Weekday-morning standup — a fresh agent session each time
agentproto cron add --schedule "0 9 * * 1-5" \
  --adapter claude-code --prompt "daily standup" --label "standup"

# Check in on a long-lived session every 15 minutes, in place
agentproto cron add --schedule "*/15 * * * *" \
  --target-session sess_abc123 --prompt "status?"

# Inspect, fire out of band, tear down
agentproto cron list --json
agentproto cron run    <id>
agentproto cron remove <id>
```

## See also

- [`serve.md`](./serve.md) — the daemon that owns the scheduler
- [`sessions.md`](./sessions.md) — the sessions `--adapter` spawns and `--target-session` re-prompts
- [`policy.md`](./policy.md) — completion gates, the other way to drive work without watching it
