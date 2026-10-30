---
"@agentproto/runtime": minor
---

The daemon now evaluates the calling agent's `delegatesTo` on every nested spawn, scoped and unscoped, and counts the verdicts on `GET /permissions/grants` under `delegation`. With `defaults.spawn.delegationGate: enforce` it refuses a child the caller does not declare with `delegation_denied` (`details.legacyCode` `role_spawn_denied`). The default `observe` changes no decision. No export is removed or renamed, and the level lattice stays for agents that declare no list.
