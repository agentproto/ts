---
"@agentproto/runtime": minor
---

Add `session_flag_status` MCP tool and `SessionsRegistry.flagAwaitingInput` method for manual correction of a session's `awaitingInput`/`awaitingQuestion` classification. This is the first external write path for these fields (otherwise set only by internal heuristics or driver-reported prompts). Includes new `session:awaiting-input-flagged` event type emitted on the session event bus for audit trail visibility via `session_events_poll`, webhook notifier, and session monitor.
