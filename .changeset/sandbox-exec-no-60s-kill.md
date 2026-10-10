---
"@agentproto/sandbox-e2b": patch
"@agentproto/runtime": patch
---

sandbox_exec on e2b no longer kills the command after e2b's 60-second default; an omitted timeoutMs now runs as long as the box lives.
