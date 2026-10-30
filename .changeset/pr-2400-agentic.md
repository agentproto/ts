---
"@agentproto/runtime": minor
---

Adds the AIP-46 delegation gate for nested spawns. The daemon now evaluates the calling agent's `delegatesTo` on every nested spawn (scoped and unscoped) and reports verdicts on `GET /permissions/grants` under `delegation`. `defaults.spawn.delegationGate` selects `off`, `observe` (default; counts and warns, changes no decision) or `enforce` (refuses an undeclared child with `delegation_denied`). New exported types `DelegationGateMode`, `DelegationVerdict` and `DelegationReport`.
