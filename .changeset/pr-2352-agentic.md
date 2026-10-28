---
"@agentproto/runtime": patch
---

Persist revoked orchestrator scopes as tombstones so a session revived after a daemon restart is reinstated with its original tools, role, depth and limits rather than a re-adopted default supervisor scope. The boot prune now drops those tombstones once their owner can never be revived, and legacy adoption runs only while no persist file exists, skips revoked tokens, and skips descriptors whose spawn role is not supervisor.
