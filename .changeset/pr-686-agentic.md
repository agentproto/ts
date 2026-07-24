---
"@agentproto/routine": patch
"@agentproto/runtime": patch
"@agentproto/skill-pack-agentproto": patch
---

Remove deprecated RoutineRunner aliases and workflow shim (Phase B3 cleanup).

The imperative RoutineRunner engine was removed in Phase B2; this PR eliminates the 4 deprecated MCP verbs (`routine_start`, `routine_status`, `routine_cancel`, `routine_escalation_resolve`), their HTTP run routes, and the thin `routine-workflow-shim.ts` that backed them. Preserves AIP-41 routine tools (`routine_list`, `routine_trigger`, `routine_reconcile`) and the `GET /routines` registrar listing route.
