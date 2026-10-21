---
"@agentproto/runtime": patch
---

Fix role/orchestrator propagation through the sandbox start path: a sandbox spawn with `role: "supervisor"` + `orchestrator: true` no longer receives the executor disposition in the inner prompt, and role-defaulted sandbox orchestrator spawns resolve supervisor (the delegation surface exists inside the box). An executor stays a leaf: no orchestrator scope is ever forwarded for a delegation-denied role.
