---
"@agentproto/auth": minor
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

Route/account selection moves into the auth model instead of CI glue. An auth
profile can now declare extra billing `routes` it serves beyond its primary
`endpoint` (e.g. one OpenCode key billed on both the `opencode-go` Go route and
the `opencode` Zen route); the eligibility predicate admits the profile on any
declared route. `agent_start` / `SpawnAgentSessionInput.access` accepts an
ordered `profileRefs: string[]` (superseding `profileRef`), and the runtime bills
the FIRST profile eligible for the model's route, failing closed with the
candidate list when none are. `auth profile create` gains a repeatable
`--route <route>` flag. Absent `routes`/`profileRefs` behaves exactly as before.
