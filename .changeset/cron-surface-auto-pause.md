---
"@agentproto/runtime": patch
---

A cron job that auto-pauses is no longer silent. The scheduler sends one `fyi` notice carrying `pausedReason` to the job's owner (or session creator) session, in addition to the existing `cron:unhealthy` event, and `daemon_health` reports `cron: { paused, pausedJobs }` with each paused job's label and reason. Pause and resume semantics are unchanged.
