---
"@agentproto/runtime": minor
---

Derive the interception level per harness (`intercept`, `permission-gate`, `observe`, `unavailable`) from the session arm, `permissionHold` and the declared native hooks.
`session_capabilities` and `GET /sessions/:id/capabilities` now expose it as `interception` for agent-cli sessions.
