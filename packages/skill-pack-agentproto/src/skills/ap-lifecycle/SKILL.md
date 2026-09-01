---
name: ap-lifecycle
description: Kill, interrupt, restart, archive, pin, and garbage-collect agentproto sessions safely — including cleaning up a spawn tree's children. Triggers — "kill this session", "stop the agent", "archive old sessions", "restart a crashed session", "clean up sessions", "garbage collect", "pin this session so it doesn't get reaped".
---

# Session Lifecycle (Kill, Restart, Archive, GC)

## When to use

You need to end, pause, recover, hide, or bulk-clean agentproto sessions —
distinct from spawning (ap-spawn-agent) or waiting on them (ap-wait-fanin).
Covers the full state machine: live → interrupted/killed → restarted, and
live → archived/gc'd → gone from the default listing.

## MCP: ending or pausing a turn

`agent_kill` terminates a session outright.
```json
{ "tool": "agent_kill", "args": { "sessionId": "sess_abc123" } }
```

`agent_interrupt` cancels the in-flight turn but keeps the session alive and
idle — use this instead of `agent_kill` when you want to redirect the agent
rather than end it.
```json
{ "tool": "agent_interrupt", "args": { "sessionId": "sess_abc123" } }
```

## MCP: recovery

`session_restart` respawns an exited or killed session with conversation
continuity — it does not start fresh, it resumes.
```json
{ "tool": "session_restart", "args": { "sessionId": "sess_abc123" } }
```

## MCP: visibility and retention

```json
{ "tool": "session_archive", "args": { "sessionId": "sess_abc123" } }
```
```json
{ "tool": "session_unarchive", "args": { "sessionId": "sess_abc123" } }
```
Archiving hides a session from the default list; it's reversible via
`session_unarchive`. `session_archive` refuses to archive a still-live
session — kill or let it finish first.

```json
{ "tool": "session_gc", "args": { "mode": "archive", "olderThanDays": 14 } }
```
Bulk archives (or bulk forgets, depending on `mode`) terminal sessions past a
retention window. Never touches sessions that are still live.

```json
{ "tool": "session_set_keepalive", "args": { "sessionId": "sess_abc123", "keepalive": true } }
```
Exempts a session from the idle-reaper — use for a long-running background
watcher you don't want auto-archived out from under you.

```json
{ "tool": "session_set_pinned", "args": { "sessionId": "sess_abc123", "pinned": true } }
```
Pins a session so it stays at the top of listings and survives casual GC
sweeps.

## MCP: corrections and conversation state

`session_rename` labels a session; `session_flag_status` manually corrects
`awaitingInput` when the daemon's own detection got it wrong.
```json
{ "tool": "session_rename", "args": { "sessionId": "sess_abc123", "name": "billing-migration" } }
```
```json
{ "tool": "session_flag_status", "args": { "sessionId": "sess_abc123", "awaitingInput": false } }
```

`session_checkpoint` snapshots before a risky compact; `session_compact`
shrinks context; `session_continue_fresh` starts a new conversation that
still carries the session's identity/history pointer forward.
```json
{ "tool": "session_checkpoint", "args": { "sessionId": "sess_abc123" } }
```
```json
{ "tool": "session_continue_fresh", "args": { "sessionId": "sess_abc123" } }
```

## CLI

```bash
agentproto sessions stop sess_abc123
```

## Gotchas

- **Killing a parent does NOT kill its children.** List them first with
  `session_tree`, then kill each one explicitly — orphaned children keep
  running and keep burning tokens.
- `session_archive` refuses live sessions outright; interrupt or kill first.
- An "already has an in-flight prompt" error on `session_restart` means the
  session is corrupted (often from a mid-wait kill — see ap-wait-fanin).
  Archive it and move on; retrying `session_restart` will not fix it.

## Pointers

- ap-spawn-agent — the other end of the lifecycle, creating sessions
- ap-prompt-agent — redirecting a live session instead of killing it
- ap-read-output — check what happened before you kill or archive
