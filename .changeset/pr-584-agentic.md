---
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

Stamp origin field on spawns from CLI, cron scheduler, and webhook/inbound watcher to track source channel and improve session lineage visibility. Extends the origin-tracking feature introduced in PR #575.
