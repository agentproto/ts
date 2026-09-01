---
name: ap-prompt-agent
description: Send a follow-up prompt to a live agentproto session, interrupt its in-flight turn, switch its model/effort/posture without restarting, or manage its queued prompts. Use when the user says "tell the agent to also...", "interrupt and redirect it", "switch that session to a cheaper model", "promote/skip that queued prompt", or "cancel that queued message".
---

# Prompt a Live Agent Session

## When to use

You already have a running session (from `ap-spawn-agent`) and need to send
it more instructions, redirect it mid-turn, change its model/effort/posture
on the fly, or manage a backlog of prompts queued while it was busy.

## MCP tool: agent_prompt

```json
{
  "tool": "agent_prompt",
  "args": {
    "sessionId": "sess_5f9a3c38",
    "prompt": "Also add a changelog entry for the validation fix.",
    "interrupt": false
  }
}
```

By default, `interrupt:false` and a prompt sent while the session is
mid-turn is **rejected** with a `mid-turn` error — it does not queue itself
automatically. Pass `interrupt:true` to cancel the in-flight turn and
redirect the same session immediately:

```json
{
  "tool": "agent_prompt",
  "args": {
    "sessionId": "sess_5f9a3c38",
    "prompt": "Stop — scope changed, only fix the email check, skip the password change.",
    "interrupt": true
  }
}
```

## Live model/effort/posture switches

No restart needed — these apply to the session in place:

```json
{ "tool": "agent_set_model", "args": { "sessionId": "sess_5f9a3c38", "model": "claude-haiku-4-5-20251001" } }
{ "tool": "agent_set_effort", "args": { "sessionId": "sess_5f9a3c38", "effort": "low" } }
{ "tool": "agent_set_posture", "args": { "sessionId": "sess_5f9a3c38", "posture": "cautious" } }
```

## Queue family (prompts that arrive mid-turn)

A FIFO queue holds prompts sent while a session is busy:

```json
{ "tool": "session_queue_list", "args": { "sessionId": "sess_5f9a3c38" } }
{ "tool": "session_queue_promote", "args": { "sessionId": "sess_5f9a3c38", "queueItemId": "q_1" } }
{ "tool": "session_queue_deliver", "args": { "sessionId": "sess_5f9a3c38", "queueItemId": "q_1" } }
{ "tool": "session_queue_drop", "args": { "sessionId": "sess_5f9a3c38", "queueItemId": "q_1" } }
```

- `session_queue_promote` reorders — jumps an item to the front of the
  queue, but the **current turn still finishes first**.
- `session_queue_deliver` force-dispatches **now**, interrupting the
  current turn (like `agent_prompt` with `interrupt:true`, but for an
  already-queued item).
- `session_queue_drop` cancels a queued item without ever delivering it.

## HTTP

```bash
curl -X POST http://127.0.0.1:18790/sessions/sess_5f9a3c38/prompt \
  -H 'content-type: application/json' \
  -d '{"prompt":"Also add a changelog entry.","interrupt":false}'

curl -X POST http://127.0.0.1:18790/sessions/sess_5f9a3c38/interrupt
```

## Gotchas

- An error like `already has an in-flight prompt` on a session **you spawned
  and are supervising** means treat that session as dead — do not
  retry-restart it. Pull whatever it produced via `agent_output` and move
  on rather than looping on retries.
- `interrupt:true` cancels the current turn's work-in-progress — only use it
  when the redirect is worth losing whatever the agent was mid-way through.

## Pointers

- ap-spawn-agent — creating the session you're now prompting
- ap-read-output — reading the result of the prompt you just sent
- ap-wait-fanin — waiting on a session after prompting it
- pb-boss-checkins — periodic re-prompting on a schedule
