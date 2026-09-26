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
mid-turn is **queued** (FIFO) and dispatched automatically once the current
turn ends — fan-in bursts are delivered in order instead of rejected. Pass
`interrupt:true` to cancel the in-flight turn and redirect the same session
immediately instead of waiting for the queue:

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

## Prompt or message?

`agent_prompt` DRIVES a session (it's a delegation action). To talk to a
tree neighbour — answer your child's blocker, send your parent a result —
send a typed **message** instead: the daemon attests you as the sender, the
recipient sees it as an `<agentproto-message>` block (never as the user),
and it's routed by urgency.

```json
{ "tool": "message_send", "args": { "to": "sess_5f9a3c38", "text": "Use branch main.", "kind": "report" } }
{ "tool": "message_reply", "args": { "replyTo": "msg_3f2a91c0", "text": "Approved — go ahead." } }
{ "tool": "message_parent", "args": { "message": "Tests pass, PR opened.", "kind": "done" } }
```

| urgency | busy recipient gets it… |
|---|---|
| `fyi` | inbox only (no wake) |
| `next-turn` (default for report/done/notice) | as its own turn when the current one ends |
| `steer` (default for blocker/question) | injected into its running turn, if its agent supports steering (`steering: true` in `session_list`) — else next-turn |
| `interrupt` | cancels its turn — only if the operator allows it (`defaults.messaging.agentInterrupt`), else `steer` |

A recipient blocked in `inbox_wait` receives the message as that call's
result. Every send result reports `urgencyApplied` — the tier actually used.

## Live model/effort/posture switches

No restart needed — these apply to the session in place:

```json
{ "tool": "agent_set_model", "args": { "sessionId": "sess_5f9a3c38", "model": "claude-haiku-4-5-20251001" } }
{ "tool": "agent_set_effort", "args": { "sessionId": "sess_5f9a3c38", "effort": "low" } }
{ "tool": "agent_set_posture", "args": { "sessionId": "sess_5f9a3c38", "posture": "cautious" } }
```

## Queue family (prompts that arrive mid-turn)

A FIFO queue holds prompts sent while a session is busy — `agent_prompt`
queues by default (`queue:true` implicitly); pass `queue:false` explicitly
to restore the old reject-with-`mid-turn`-error behavior instead:

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
- pb-supervise-parallel-mission — the `inbox_wait` loop for collecting children's reports
- pb-boss-checkins — periodic re-prompting on a schedule
