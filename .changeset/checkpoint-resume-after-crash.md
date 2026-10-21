---
"@agentproto/runtime": minor
---

Crash resume: a relaunch puts the crashed session's checkpoint back.

A sandbox session that crashed in its box left its work in a checkpoint the relaunch could not find. The checkpoint ref is named after the WORK TREE (`agentproto-checkpoint/wt/<slug>`, a slug minted per spawn), so nothing linked a relaunch to the snapshot that held the work, and every relaunch started from the base branch: the work was on the remote, but the agent never saw it again.

- The session now OWNS its checkpoint: the daemon writes the ref of the snapshot (plus its sha, the work branch and the session id) into the session row (`lastCheckpoint`) when it creates the checkpoint, so the link can never drift from the checkpoint itself.
- A restart of a dead box restores THAT ref on the fresh checkout (`git restore --source=<ref> --staged --worktree -- .`), instead of guessing the snapshot from the branch name.
- A new `agent_start` can be linked to the session whose work it continues: `resumeFrom: { sessionId }` names it explicitly, `resumeFrom: { label }` (or `{ taskId }`) correlates with the dead sessions carrying that label. The relaunch restores the recorded checkpoint and reuses the dead session's work branch, so the pushed commits come back as commits. A LIVE session is never resumed.
- The restore is best effort and never fatal: a missing ref, a sha that does not match, or a dirty checkout leaves the checkout alone and the step says so. Only a checkpoint that actually reached the remote is restorable.
