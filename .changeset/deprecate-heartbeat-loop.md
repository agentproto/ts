---
"@agentproto/runtime": patch
---

Mark the HEARTBEAT.md autonomy loop deprecated in favour of cron and routines (comment and README only, no behavior change). The cron guide now documents pause and resume through `cron_update active`, routines compiling to cron jobs, and auto-pause with `pausedReason`.
