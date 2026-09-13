---
name: ap-cron
description: Schedule recurring or one-shot jobs on the agentproto daemon — cron_create with command, agent, or prompt-session actions, cron_list to inspect, cron_run to test-fire, cron_delete to remove. Trigger when asked for cron jobs, scheduled agent runs, nightly check-ins, one-shot timers, or durable session re-pings.
---

# ap-cron

## When to use

- Work must run on a schedule with nobody prompting it (nightly audits, periodic sweeps).
- A long-running mission needs periodic check-ins that keep its context alive.
- You want a delayed one-shot action ("in 20 minutes, poke the deploy").

## Create a job

`cron_create` takes a 5-field cron expression in **local time** and exactly one action. `label` is the human-readable name; `recurring` defaults to `true`.

```json
{
  "schedule": "0 9 * * 1-5",
  "label": "morning-standup",
  "action": {
    "kind": "agent",
    "adapter": "claude-code",
    "prompt": "Summarize overnight commits and draft the day's priority list.",
    "cwd": "/repo",
    "model": "claude-sonnet-4-5"
  }
}
```

Three action kinds:

- **command** — run an allowlisted executable. `command` is the basename (`git`, not `/usr/bin/git`) and must be listed in `<workspace>/.agentproto/allowed-commands.json`.

```json
{
  "schedule": "*/30 * * * *",
  "label": "health-check",
  "action": { "kind": "command", "command": "curl", "args": ["-fsS", "http://localhost:8080/health"], "cwd": ".", "timeoutMs": 15000 }
}
```

- **agent** — spawn a brand-new session on each firing. Use for self-contained periodic work.
- **prompt-session** — re-ping an EXISTING living session by id.

```json
{
  "schedule": "0 8,14,20 * * *",
  "label": "mission-checkin",
  "action": { "kind": "prompt-session", "sessionId": "sess_abc123", "prompt": "Check-in: post progress, blockers, and next step." }
}
```

## Inspect, test, delete

```json
cron_list({})          // every job, active + inactive, with schedule, lastResult, nextRunAt
cron_run({ "jobId": "job_01J..." })     // fire NOW, bypassing the schedule — the test path
cron_delete({ "jobId": "job_01J..." })  // permanent removal
```

After creating a job, call `cron_run` once and read `lastResult` from `cron_list` before trusting the schedule. A fired cron does not notify you — `lastResult` is the only feedback.

## Durable check-ins on a long mission

Spawn the mission agent once (see ap-spawn-agent), then attach a `prompt-session` cron instead of respawning agents per check-in. The session keeps its full context and just gets nudged. This is the pattern behind supervise-long-missions and pb-boss-checkins. If the target session dies, re-pinging fails — revive it first (ap-lifecycle).

## Gotchas

- Cron jobs are persistent HOST-level jobs that survive daemon restarts. One-shot jobs MUST set `recurring: false` or they fire forever.
- `prompt-session` targets a session id, not a name — dead ids fail; check `lastResult` to see it.
- The `command` kind is allowlist-gated by basename: the executable's basename must appear in `<workspace>/.agentproto/allowed-commands.json`, even when you pass an absolute path.
- Schedules are local time, not UTC — `0 9 * * 1-5` means 9am wherever the daemon runs.
- Deleting is permanent; there is no pause. To suspend a job, delete and recreate it with the same label.

## Pointers

- agentproto — daemon overview and where these tools live.
- ap-spawn-agent — create the session a prompt-session cron re-pings.
- ap-wait-durable — the waiting-side counterpart for durable supervision.
- supervise-long-missions — the strategy this tool implements.
- pb-boss-checkins — packaged check-in workflow.
