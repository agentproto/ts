---
"@agentproto/runtime": minor
---

Resume the last checkpoint of a session that died, instead of starting over
from the base branch.

The daemon already snapshots a sandbox session's uncommitted work and
force-pushes it to `agentproto-checkpoint/<worktree>` on the workspace
remote, but that ref is named after the WORK TREE, which is minted per spawn:
nothing told a relaunch which snapshot belonged to the session that died, so
every relaunch started from `main` again.

The session now keeps the link to its own last checkpoint
(`SessionDescriptor.lastCheckpoint`: ref, sha, branch, session id), written by
the same code path that creates the checkpoint, so it cannot drift from the
checkpoint itself. A relaunch resolves that link:

- `session_restart` of a dead box restores the recorded ref with
  `git restore --source=<ref>` instead of guessing from the branch name;
- a new `agent_start` linked to a dead session through the new `resumeFrom`
  argument (`{ sessionId }`, or a `{ label }` / `{ taskId }` correlation
  against the dead sessions) restores the same recorded ref and reuses the
  dead session's work branch, so its pushed commits come back as commits;
- a LIVE session is never resumed - its work is still in its box.

The restore is a best-effort setup step, never fatal: a missing ref, a
dirty checkout or a failed fetch leaves the session where it is and says so.
Only a checkpoint that actually reached the remote is restorable.
