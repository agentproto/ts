---
"@agentproto/runtime": minor
---

Stop persisting the live-only `availableCommands` list on session rows, omit it from the default `GET /sessions` projection (still available via `?fields=availableCommands` and always on `GET /sessions/:id`), and drop a finished session's output rings (lines, PTY bytes, stream buffers) in the shared exit funnel once its final text has been captured. `agent_output` and the HTTP output route fall back to that final text, and `terminal_output` / `GET /sessions/:id/preview` recover a finished PTY's scrollback from `terminal.jsonl`, so a completed session is still readable.
