---
"@agentproto/cli": minor
"@agentproto/runtime": minor
"@agentproto/worktree": minor
---

feat(worktree): throttle heavy worktree provisioning through a daemon-wide FIFO queue. `depsCmd`, `cloneGlobs` and setup hooks now run at most `worktrees.provisionConcurrency` (default 2, `0` = unlimited, env `AGENTPROTO_WORKTREES_PROVISION_CONCURRENCY`) at a time, fair across callers, with optional per-repo caps and a `provisionLoadFactor` load guard. Killing a `starting` session drops its queued provisioning or terminates a running install's whole process tree and removes the half-made worktree. Sessions report `provisioning: { state, position, phase, startedAt }` in `agent_sessions_list`, `session_list` and `agentproto sessions`, and the event bus emits `session:provisioning` events.
