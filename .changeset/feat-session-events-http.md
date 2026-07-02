---
"@agentproto/runtime": patch
"@agentproto/driver-agent-cli": patch
---

Add `GET /sessions/:id/events` to the runtime HTTP server — reads a session's structured `events.jsonl` capture directly (the same on-disk source `/export`'s daemon-events strategy reads) so a web panel can render rich components instead of the collapsed markdown/JSON transcript. Supports `since`/`limit` query params for incremental polling and returns `{sessionId, events, nextSeq, complete}`; 404s with `{error: "no_transcript"}` when the session never captured any events.

Fix the print arm's mastracode `tool_start` mapping to read the tool call payload from the upstream `args` field instead of `input` (which is the Claude Code stream-json field name, not Mastra's) — tool-call StreamEvents from mastracode sessions were always carrying empty `arguments`.
