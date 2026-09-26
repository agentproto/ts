---
"@agentproto/worktree": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Worktree status now carries base divergence (`dirty`/change counts, ahead/behind vs the default branch), PR web URLs built from a GitHub `origin` (including ssh host aliases), a per-session `worktree_status { sessionId }` / `GET /worktrees?sessionId=` narrow read, and new session descriptor fields `mainRepoPath` and `commandSandbox`. Adds `computeBaseDivergence`/`BaseDivergence` and `githubPrUrlBuilder` exports; `listWorktreeStatuses` accepts a `paths` filter.
