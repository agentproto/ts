---
"@agentproto/runtime": patch
---

Session events paths are now discoverable and configurable. The `agent_start` spawn response descriptor (and every `GET /sessions/:id`) carries `eventsPath` — the absolute path of that session's `events.jsonl`, resolved from the same base dir the transcript writer actually writes to, never re-derived by the caller. The events root itself is configurable via a new `sessions.eventsDir` key in `~/.agentproto/config.json`; every writer/reader (transcript writer, `/sessions/:id/events` HTTP routes, exports, tool-call/usage logs) resolves through one helper. Default stays `~/.agentproto/sessions` — zero behaviour change out of the box.
