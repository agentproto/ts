# @agentproto/routine

## 0.2.0

### Minor Changes

- 4d200a9: Implement AIP-41 routine runtime bridge: tight schema for `target` union (tool/agent/workflow/action), `RoutineRegistrar` that reads `.routines/*/ROUTINE.md` and registers cron jobs, `dispatchTool` gateway for in-process MCP tool calls, HTTP `/routine-defs/:id/trigger` and MCP `routine_trigger` tool (mirrors `cron_run`). New `TargetAgent` sugar kind for agent spawning (ahead of upstream draft). Comprehensive unit + integration tests proving all three target kinds fire through real dispatch mechanism.

### Patch Changes

- 5becedc: Add `routine_reconcile` verb and HTTP route for on-demand re-scan of routine definitions. Tighten `schedule` schema from `z.any()` to validated discriminatedUnion with cron/interval/calendar/manual/event kinds, improving type safety and validation coverage.
- 1cbb910: Remove deprecated RoutineRunner aliases and workflow shim (Phase B3 cleanup).

  The imperative RoutineRunner engine was removed in Phase B2; this PR eliminates the 4 deprecated MCP verbs (`routine_start`, `routine_status`, `routine_cancel`, `routine_escalation_resolve`), their HTTP run routes, and the thin `routine-workflow-shim.ts` that backed them. Preserves AIP-41 routine tools (`routine_list`, `routine_trigger`, `routine_reconcile`) and the `GET /routines` registrar listing route.

## 0.1.2

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/define-doctype@0.1.1
  - @agentproto/manifest@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [1fc1750]
- Updated dependencies [1fc1750]
  - @agentproto/manifest@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies [44192c9]
  - @agentproto/manifest@0.1.0
