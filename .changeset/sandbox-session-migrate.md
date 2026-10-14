---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

`session_migrate` (MCP, `POST /sessions/:id/migrate`, `agentproto sessions migrate`) resumes a sandbox session on a new box: it takes a final checkpoint of the old box when it is still reachable, boots a fresh box from the workspace remote, restores the work branch and the pushed uncommitted snapshot (commits stay commits, the snapshot stays uncommitted), carries the transcript over via the context checkpoint, then stops the old box. A shared `restoreCheckpointSteps` planner now backs spawn, restart and migrate.
