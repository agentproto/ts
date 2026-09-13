---
name: ap-wait-durable
description: Get notified when a spawned agentproto session finishes WITHOUT blocking your own turn — background a CLI wait with a completion notification, or arm a cron re-ping as a durable fallback that survives daemon restarts. Triggers — "notify me when it's done", "wait in the background", "don't block on this", "durable check-in", "ping me later".
---

# Wait For Sessions Without Blocking (Durable)

## When to use

You need to know when a spawned agentproto session finishes, but you don't
want to sit inside a single turn blocking on it — either because the wait
could be long, or because you want to keep working on other things in the
meantime. This is the non-blocking counterpart to ap-wait-fanin.

## Pattern: background CLI wait with a notification

Run the wait as a background terminal process and let its completion notify
you, instead of parking your own turn on it.

```bash
agentproto sessions wait sess_abc123 --until turn-end
```

Launched via a Hermes terminal with `background=true,
notify_on_complete=true`, the wait runs off to the side and its completion
arrives as a new message — zero polling inside your own context.

```bash
agentproto sessions --watch
```

Alternative for open-ended supervision of many sessions at once rather than
one specific wait.

## Pattern: cron re-ping as a durable fallback

For waits that must survive a daemon restart, or where a background terminal
isn't an option, arm a cron job that re-pings your own living session by id.

### MCP: cron_create
```json
{
  "tool": "cron_create",
  "args": {
    "schedule": "*/10 * * * *",
    "action": { "kind": "prompt-session", "sessionId": "sess_self001" },
    "prompt": "Check whether sess_abc123 has finished its turn yet."
  }
}
```

### MCP: cron_list / cron_run / cron_delete
```json
{ "tool": "cron_list", "args": {} }
```
```json
{ "tool": "cron_run", "args": { "cronId": "cron_77f1" } }
```
```json
{ "tool": "cron_delete", "args": { "cronId": "cron_77f1" } }
```
`cron_run` fires the job immediately (useful to test it before trusting the
schedule); `cron_delete` disarms it once the wait is over — a stale
re-ping cron will keep nagging a session that no longer needs it.

## Gotchas

- From a cowork/Hermes session, prefer `terminal(background=true,
  notify_on_complete=true)` over anything foreground — the notification
  lands as a new message with zero polling cost to your context.
- `cron_create` with `prompt-session` re-pings a LIVING session by id. It is
  the durable alarm that survives daemon restarts, but it is a nudge that
  re-invokes you to go check — not a wait result delivered automatically.
  Your re-invoked turn still has to call agent_output or session_events_poll
  to actually learn the outcome.
- Never foreground-block your own turn with a long sleep to simulate a wait
  — watchdogs will kill long in-turn sleeps, and (per ap-wait-fanin) killing
  a wait mid-flight can corrupt the session being waited on.
- Delete the cron once the wait resolves; an armed re-ping left behind will
  keep firing on schedule and burning tokens on a session that's long done.

## Pointers

- ap-wait-fanin — the blocking, in-turn version of this same problem
- ap-cron — general cron primitives beyond the wait use case
- supervise-long-missions
