---
"@agentproto/runtime": patch
---

Forward `resolveSandboxProvider` to scoped orchestrator gateway, fixing regression where children spawned through the orchestrator sub-gateway couldn't resolve sandbox providers even though the daemon had one.
