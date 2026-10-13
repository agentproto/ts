---
"@agentproto/runtime": minor
"@agentproto/worktree": minor
---

Sandbox deliveries now delete the `agentproto-checkpoint/<branch>` remote branch once the work it rescued is safe (clean checkout, work branch pushed or nothing ahead): a session no longer leaves a stale checkpoint branch on the remote forever, and branch GC reclaims leftovers whose work branch is merged (`checkpoint-superseded`).
