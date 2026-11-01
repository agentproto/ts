---
"@agentproto/runtime": minor
---

cron jobs now record `createdBy` (operator, system, external, or a session with `proven` or `claimed` proof), frozen at creation and shown by `cron_create` and `cron_list`; it is not yet used to restrict what a fired job may do.
