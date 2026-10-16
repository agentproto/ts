---
"@agentproto/runtime": minor
---

Cron jobs gain `ownedBy` + `expiresAt` lifetime guards: a session-created job is tagged with its owner (from `?callerSessionId=`) and retired — or relinked to a live successor — once that owner is gone, with a default 7-day expiry; `cron_create`/`cron_update`/`cron_list` surface both.
