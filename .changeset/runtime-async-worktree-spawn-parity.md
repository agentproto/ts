---
"@agentproto/runtime": patch
---

Async worktree spawns now start the driver and record the descriptor through the same builders as synchronous spawns: one helper builds the start options (resume target, config dir, app-boundary fs zones and host-context isolation, env) and one builds the descriptor meta. A resumed async worktree spawn now hands the adapter the resolved conversation id and its config dir instead of the raw session id and a fresh dir, and an async worktree session spawned from an agent manifest now records `agentId`, `agentManifestPath` and the role hashes.
