---
name: pb-boss-checkins
description: Stay accountable on a long mission by scheduling a cron boss that re-prompts your own session on a fixed local-time schedule. Trigger for durable check-ins - 'cron a status report', 'wake me on a schedule', 're-prompt my session periodically', 'mission check-in boss'.
---

# pb-boss-checkins — a cron boss re-prompts my own session

## Goal

A long mission outlives your attention. Install a cron boss that fires on a
local-time schedule and re-prompts YOUR OWN session with a status question,
so every tick forces a real report: tasks done, children alive, blockers,
next action. Delete the boss when the mission ends.

Prerequisites (reference by name): `ap-cron`, `ap-lifecycle`, `ap-tasks`,
`ap-spawn-agent` (only for the `agent`-kind variant). The family map is the
`agentproto` skill; the `supervise-long-missions` group covers the wider
supervision playbook.

## Steps

### 1. Get your own session id

The boss targets a session id, so know yours (from your spawn descriptor or
`session_list` on the daemon).

### 2. Create the boss

```
cron_create({
  schedule: '30 4 * * *',
  action: {
    kind: 'prompt-session',
    sessionId: '<my session id>',
    prompt: 'report status: tasks done? agents alive? blockers? next action?'
  }
})
```

Five-field cron in LOCAL time: minute hour day-of-month month day-of-week.
The response returns the job id and `nextRunAt` — note both. A morning tick
(04:30 Paris in the example) fits the credit-reset cycle; pick whatever
cadence keeps the mission honest.

### 3. Answer every tick with a real status

When the boss fires, it wakes your session with the prompt. Answer it with
facts, not intentions:

- `task_update({taskId, rev, note})` notes on the task board for progress.
- `session_tree({})` to confirm children are alive or finished.
- Name the next concrete action, or declare the mission complete.

### 4. Delete the boss when the mission ends

```
cron_delete({ jobId: '<jobId>' })
```

The job is a persistent host-level job that survives daemon restarts — a
forgotten boss pings your session forever. This step is not optional.

## Variants

- Machine check-in (`kind: 'command'`): run an allowlisted command on each
  tick — a build, a test, a heartbeat script. Good when the status you need
  is green/red rather than a report.
- Independent reviewer (`kind: 'agent'`): spawn a BRAND-NEW agent session on
  each tick with a review prompt. Costs more per tick, but the reviewer has
  no stake in your session's narrative and audits from a fresh context.
- Follow-up on a child: `kind: 'prompt-session'` also works against a child
  session id, turning a periodic check-in into a per-agent heartbeat.

## Gotchas

- `prompt-session` targets a LIVING session by id. A dead session is a
  SILENT MISS — the job fires, nothing happens. If your session might not
  survive, restart it first or switch to the `agent` kind, which always
  spawns fresh.
- Cron survives daemon restarts. ALWAYS delete it when done — or it pings
  forever.
- Test with `cron_run({jobId})` BEFORE trusting the schedule: it fires the
  job immediately so you confirm the prompt reaches the right session with
  the right wording.
- One-shot missions: pass `recurring: false` so the job deactivates after a
  single fire instead of lingering until you remember to delete it.

## Verify

`cron_run({jobId})` produces an actual status turn in the target session
(the prompt appears, you answer it with facts), `cron_list` shows the job
with a sane `nextRunAt`, and after the mission `cron_delete` removes it —
`cron_list` no longer lists it. A boss you have not test-fired is unverified.
