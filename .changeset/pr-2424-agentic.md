---
"@agentproto/runtime": patch
---

Exempt only explicitly pinned rows from the `keepAlive` boot-resume idle cutoff. An `operatorLabel` is identity metadata stamped on every operator spawn (executors included) and no longer bypasses the cutoff, so stale keepAlive executors stay dead-but-lazy-resumable instead of being respawned on every daemon boot. Documentation, config help text, and tests are updated to match.
