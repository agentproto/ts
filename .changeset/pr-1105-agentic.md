---
"@agentproto/runtime": patch
---

Add logging to dedupe hits in `spawnAgentSession` to improve observability. When an idempotency key hit occurs, the runtime now logs a warning message that includes the returned session ID, spawn context (adapter, cwd), and label if provided. This helps diagnose cases where a repeated `agent_start` call returns an existing session.
