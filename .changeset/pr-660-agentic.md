---
"@agentproto/mcp-server": patch
"@agentproto/routine": patch
"@agentproto/runtime": patch
---

Add `routine_reconcile` verb and HTTP route for on-demand re-scan of routine definitions. Tighten `schedule` schema from `z.any()` to validated discriminatedUnion with cron/interval/calendar/manual/event kinds, improving type safety and validation coverage.
