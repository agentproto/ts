---
"@agentproto/runtime": minor
---

Stop persisting the live-only `availableCommands` list on session rows and omit it from the default `GET /sessions` projection (still available via `?fields=availableCommands` and always on `GET /sessions/:id`). Agent-cli rows drop their output rings and stream buffers at exit once the final text is captured; PTY rows keep their capped 64 KiB byte ring so `terminal_output` and `GET /sessions/:id/preview` still have scrollback immediately after exit. `terminal.jsonl` is only a fallback for a terminal row with an empty ring. `agent_output` and `GET /sessions/:id/output` still serve a finished executor from its captured final text.
