---
"@agentproto/runtime": major
"@agentproto/routine": patch
"@agentproto/skill-pack-agentproto": patch
---

Phase B3: Remove deprecated RoutineRunner aliases (`routine_start`, `routine_status`, `routine_cancel`, `routine_escalation_resolve` MCP tools and associated HTTP routes). The imperative RoutineRunner engine was retired in Phase B2; these aliases offered no capability that single-step-per-stage AIP-15 workflows don't cover. Migrate to `workflow_start` with single-step stages for sequential runs. AIP-41 routine definitions (registrar-based) remain intact and unaffected.
