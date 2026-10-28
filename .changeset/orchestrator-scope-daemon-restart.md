---
"@agentproto/runtime": patch
---

An orchestrator scope no longer comes back wider after a daemon restart. Revoked scopes are now kept in `orchestrator-scopes.json` with their original tools, role, depth and limits, so restarting a crashed session after a daemon restart restores exactly that scope, and the boot prune drops them once their owner can never be revived. The legacy adoption no longer resurrects a revoked token with the default supervisor scope: it skips tokens the file holds as revoked, runs only while no persist file exists, and skips descriptors whose spawn role is not supervisor.
