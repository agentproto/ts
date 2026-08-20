---
"@agentproto/acp": patch
"@agentproto/runtime": patch
---

Surface ACP's `available_commands_update` notification instead of silently dropping it. `translateSessionUpdate` now maps it to a new `available-commands` StreamEvent, `transcript-writer` persists it to `events.jsonl`, and the daemon mirrors the latest command list onto `SessionDescriptor.availableCommands`, exposed read-only via `GET /sessions` / `GET /sessions/:id`.
