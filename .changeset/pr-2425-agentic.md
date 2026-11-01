---
"@agentproto/runtime": minor
---

Cron jobs now record a frozen `createdBy` principal (`operator`, `system`, `external`, or a session with `proven`/`claimed` proof), shown by `cron_create` and `cron_list`. The field records who created a job and how well they were proven; it is not yet used to restrict what a fired job may do.
