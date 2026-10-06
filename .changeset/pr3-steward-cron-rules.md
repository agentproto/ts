---
"@agentproto/runtime": minor
"@agentproto/apps": minor
---

Session steward: port the `kill-idle-sessions` cron prototype's mechanical
rules into pure, unit-tested functions wired into the workflow — loop
detection, stall, never-ran, fast-path done, terminal relabel, self-exclusion,
apply-time re-check, explicit 0-candidate reporting, host-saturation header,
and verdict memory in `app_state` — and enrich `session_evidence` (origin,
outcome, tool stats, last tool call, tokens, live children, previous verdict)
with a rewritten concrete-signal wrap-up verdict criteria. Loop/stall nudges
are reported only, never sent; user-origin sessions are never nudged or closed.
