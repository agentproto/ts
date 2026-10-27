---
"@agentproto/runtime": patch
---

Let the `cron-ok` follow-triage rule match command cron runs by their `cron:<jobId>` label and nearest run when the run record has no session id.
