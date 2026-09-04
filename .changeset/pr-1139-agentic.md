---
"@agentproto/worktree": minor
---

Add `writeFiles` parameter to `worktree.provision` for generating worktree-specific configuration before `depsCmd` runs. Supports `create` mode (never-clobber) and `append` mode (with automatic `skip-worktree` marking to prevent accidental commits).
