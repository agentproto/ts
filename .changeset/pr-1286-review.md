---
"@agentproto/sandbox": patch
"@agentproto/runtime": patch
---

Guard sandbox teardown after a failed MCP connect so it never masks the original error
