---
"@agentproto/apps": patch
---

The `session-steward` workflow's two `session_wrapup_apply` steps (`autoApplyOne`, `judgedApplyOne`) now pass `wait: true`. Without it the tool falls back to a background job after its 25 s default `waitMs` and returns only `{ jobId, status: "running" }`. A slow close then came back as that bare jobId, and the report showed no outcome for a session that was in fact closed.
