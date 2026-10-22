---
"@agentproto/runtime": minor
---

Resume a crashed sandbox session from its last checkpoint instead of the base branch. Sessions record `lastCheckpoint` when a checkpoint reaches the workspace remote, `session_restart` restores that ref, and the new `agent_start.resumeFrom` (`{ sessionId }`, `{ label }` or `{ taskId }`) links a fresh spawn to a dead session, restoring its checkpoint and reusing its work branch. A live session is never resumed.
