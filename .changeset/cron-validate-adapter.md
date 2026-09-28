---
"@agentproto/runtime": minor
---

Cron jobs with an unresolvable agent adapter now fail at create time instead of silently failing at fire time. `CronScheduler.create()` is now async: for `kind:"agent"` (and `kind:"tool"` → `agent_start`, what a routine's `target.agent` lowers to) with an explicit `adapter`/`harness` and no `sandbox`, it resolves the adapter and refuses the job if it doesn't resolve. When the slug is an auth profile id, the error explains to use a real adapter with `access.profileRef`; otherwise it lists installed adapters. Jobs rehydrated from disk are not re-checked. `RoutineRegistrar.reconcile()` is now async and reports a refused routine in `errors` without aborting the rest of the pass. The compact `cron_list` projection now includes `lastOk` so a failed last run is visible without `full: true`.
