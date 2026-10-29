---
"@agentproto/runtime": patch
---

Stop persisting the live-only `availableCommands` list on session rows, and drop a finished session's output rings (lines, PTY bytes, stream buffers) in the shared exit funnel once its final text has been captured. `agent_output` and the HTTP output route fall back to that final text, so a completed executor is still readable.
