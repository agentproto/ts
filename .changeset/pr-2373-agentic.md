---
"@agentproto/runtime": patch
---

Heap hygiene for long-lived daemons: the live-only `availableCommands` list is no longer written to `sessions.json` (and is dropped when loading an older snapshot), and a finished session's output rings (lines, PTY bytes, stream buffers) are cleared in the shared exit funnel. `agent_output` and `GET /sessions/:id/output` fall back to the session's captured final text, so a completed executor is still readable.
