---
"@agentproto/apps": patch
---

Fix the repo-maintenance `maintain` workflow's held-worktree review (0.21.0) never queuing anything. `reviewableWorktrees` read `tree.state`, but the daemon's `worktree_gc` tool flattens the tree to a bare string (`tree: "clean"`), so every idle worktree was silently dropped: a live run on agentproto/ts queued 0 of the eligible held worktrees. It now reads both shapes. The tests use the daemon's real projection, and the real-runner test feeds its output through `reviewableWorktrees`.
