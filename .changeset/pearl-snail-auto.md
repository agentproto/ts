---
"@agentproto/cli": minor
"@agentproto/runtime": minor
"@agentproto/worktree": minor
---

Let worktree gc reclaim integrated worktrees whose only changes carry no work (an emptied checkout, turbo's managed AGENTS.md block, or changes already on base), reported as `reclaimReason: "dirty-no-work"` with the sub-cases in `dirtyNoWork`. Anything unexplained keeps its previous class.
