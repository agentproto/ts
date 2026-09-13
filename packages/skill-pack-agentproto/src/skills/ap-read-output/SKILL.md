---
name: ap-read-output
description: Read what an agentproto session did — tail its recent output, export the full transcript, get a one-sentence summary, check cost/tokens, or locate a specific message. Use when the user says "what did the agent do", "show me the last output", "export that session", "how much did that session cost", "summarize what happened", or "did it finish or is it stuck".
---

# Read Agent Output

## When to use

You need to inspect what a session (spawned via `ap-spawn-agent`) actually
produced — a quick tail check, the full transcript, a cost readout, or a
human-readable summary/timeline.

## MCP tools

```json
{ "tool": "agent_output", "args": { "sessionId": "sess_5f9a3c38", "lastN": 50, "clean": true } }
```

`lastN` caps at 500. `clean:true` strips ANSI escape codes for readable
text.

```json
{ "tool": "agent_export", "args": { "sessionId": "sess_5f9a3c38", "format": "markdown" } }
```

`agent_export` works on stopped sessions too — use it when you need the
whole conversation, not just the tail.

```json
{ "tool": "conversation_read", "args": { "sessionId": "sess_5f9a3c38" } }
{ "tool": "conversation_locate", "args": { "sessionId": "sess_5f9a3c38", "query": "signup validation fix" } }
{ "tool": "session_usage", "args": { "sessionId": "sess_5f9a3c38" } }
{ "tool": "agentproto_session_story", "args": { "sessionId": "sess_5f9a3c38" } }
{ "tool": "summarize_session", "args": { "sessionId": "sess_5f9a3c38" } }
```

- `session_usage` — cost and token counts for the session.
- `agentproto_session_story` — a human-readable timeline of what happened.
- `summarize_session` — a one-sentence summary plus a coarse state (e.g.
  running / idle / done).

## CLI

```bash
agentproto sessions export sess_5f9a3c38
agentproto sessions story sess_5f9a3c38
agentproto sessions mirror sess_5f9a3c38   # read-only live tail
```

## HTTP

```bash
curl http://127.0.0.1:18790/sessions/sess_5f9a3c38/events
```

## Gotchas

- `agent_output` reads from a **tail ring buffer**, not the full
  transcript — long sessions will have earlier output evicted. Use
  `agent_export` when you need everything, including the beginning.
- The `awaitingInput` flag **over-signals**: it fires both when a turn
  simply finished and when the agent is genuinely blocked waiting on a
  question. Don't trust the flag alone — read the last content line of the
  output to tell "done" from "stuck waiting on you."

## Pointers

- ap-spawn-agent — where the session you're reading came from
- ap-prompt-agent — sending a follow-up once you've read the output
- supervise-long-missions — longer-running supervision patterns
- agentproto — general daemon driving reference
