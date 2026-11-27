---
"@agentproto/runtime": patch
---

A first-turn ticket reserved for a session is now dropped (cause `superseded`) when the first turn runs under its own `promptId`, so the MCP task bound to the reservation ends `cancelled` instead of staying `working` until the session ends, with the status message "the first turn ran under a different prompt".
