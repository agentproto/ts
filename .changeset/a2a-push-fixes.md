---
"@agentproto/runtime": patch
---

A2A push delivery no longer blocks the JSON-RPC answer, sends a finished task's final event only to the new config, delivers to every config in parallel, serializes config writes and logs only the webhook origin.
