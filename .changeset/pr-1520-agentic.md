---
"@agentproto/cli": minor
"@agentproto/worktree": minor
"@agentproto/apps": patch
---

Fast worktree removal (rename to same-volume `.trash` + prune + detached background delete) wired into cleanup-worktree and gc, plus `agentproto maintain --all` with repeatable `--repo` to maintain every repo owning worktrees under the worktrees root.
