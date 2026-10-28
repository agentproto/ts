---
"@agentproto/runtime": patch
---

Give async-provisioned worktree spawns the same driver env as synchronous spawns — `AGENTPROTO_SESSION_ID`, `AGENTPROTO_WORKSPACE_SLUG`, `AGENTPROTO_PARENT_SESSION_ID`, `AGENTPROTO_APP_ID`, cloud relay vars, and the opt-in `gh` provenance shim on `PATH` — so `gh pr create` run from a worktree session carries the provenance footer (E75).
