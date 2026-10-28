---
"@agentproto/runtime": minor
---

Derive the interception level per harness (`intercept`, `permission-gate`, `observe`, `unavailable`) from the session arm, `permissionHold` and the declared native hooks, and expose it as an additive `interception` field on `session_capabilities` and `GET /sessions/:id/capabilities` for agent-cli sessions (`packages/runtime/src/action-hooks/interception.ts`, `packages/runtime/src/session-capabilities.ts`).
