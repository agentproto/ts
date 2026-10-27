---
"@agentproto/sandbox-computer": minor
---

Add typed capacity-refusal handling: new `sandbox_fleet_capacity`, `sandbox_tenant_running_cap`, `sandbox_end_user_cap`, and `sandbox_fleet_tenant_cap` error codes, an additive `cap` field on the error types, and an exported `isCapacityRefusal` predicate that classifies by controller body code rather than HTTP status.
