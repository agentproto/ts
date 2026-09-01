---
name: ap-wait-fanin
description: Wait for one or more agentproto sessions to finish a turn (fan-in) without a shell polling loop — multiplex session_monitor across children, or take a session_events_poll cursor before spawning to stay race-free. Triggers — "wait for these agents to finish", "fan in on my children", "wait until turn-end", "block until any session is done", "don't poll in a loop".
---

# Wait For Sessions To Finish (Fan-In)

## When to use

You've spawned one or more agentproto sessions (see ap-spawn-agent) and need
to know the moment any — or all — of them finish a turn, hit
awaiting-input, or exit. This is the fan-in step: block cheaply instead of
burning your own context re-checking output by hand.

## Gotchas — read this before you wait on anything

- **Never write a shell/terminal polling loop** (`for i in ...; do check;
  sleep; done`) to wait on children. A watchdog killing you mid-loop
  permanently corrupts the underlying session into an "already has an
  in-flight prompt" error that survives a restart — this happened in
  production on 2026-09-01 and the session never recovered. If you spawn a
  supervisor sub-agent that will itself wait on children, brief it
  explicitly: `session_monitor` is THE fan-in mechanism, shell poll loops are
  forbidden.
- **session_monitor can miss ultra-fast children.** If a trivial child
  finishes before you attach the watch, the watch never fires for it. Parry
  by taking a `session_events_poll` cursor BEFORE spawning children, or by
  confirming completion via `agent_output` once a timeout elapses.
- **Arm the watch at spawn time.** Wakeup timers / scheduled re-checks are a
  safety net only — the primary mechanism is the long-poll itself, not a
  cron that happens to fire later.

## MCP: session_monitor

Multiplexed long-poll across N sessions. Returns on the FIRST watched
session to fire the requested event — you decide whether to keep waiting on
the rest.

```json
{
  "tool": "session_monitor",
  "args": {
    "sessionIds": ["sess_abc123", "sess_def456"],
    "event": "turn-end",
    "timeoutMs": 45000
  }
}
```

Valid `event` values: `turn-end`, `awaiting-input`, `exited`, `any`.
`timeoutMs` accepts 1000-49000 — it is a long-poll, not an indefinite wait,
so for longer horizons re-issue the call after each timeout. Prefer the CLI
alternative below when a real shell is available to you.

## MCP: session_events_poll

The race-free alternative. Take a cursor before spawning children, then poll
cheaply on your own schedule — an event emitted before your first poll call
is still returned, so nothing is lost to a race with fast children.

```json
{
  "tool": "session_events_poll",
  "args": { "since": "cursor_9f21" }
}
```

Returns `{ events: [...], nextCursor: "cursor_9f2c" }`. Keep `nextCursor`
and pass it back in as `since` on the next call.

## CLI

```bash
agentproto sessions wait sess_abc123 --until turn-end
```

Exists in v0.16.0 though hidden from `--help`. Defaults to a 15-minute
timeout. This is the preferred mechanism when you have a shell you can
background — see ap-wait-durable for the non-blocking background pattern.

```bash
agentproto sessions --watch
```

Live-tails session state changes to the terminal. Good for interactive
supervision, not for programmatic fan-in — use `session_monitor` or
`session_events_poll` for that.

## Pointers

- ap-wait-durable — get notified without blocking your own turn
- ap-spawn-agent — spawn the sessions you're about to wait on
- supervise-long-missions
- pb-supervise-parallel-mission
