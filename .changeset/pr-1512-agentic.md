---
"@agentproto/worktree": minor
---

gc: add a narrow "plans-only" salvage rule so no-commit worktrees whose only dirt is untracked `.plans/` files archive via `--salvage-dirty` instead of holding forever; widen the default noise allowlist to lockfile and launch-config churn; hold merged+dirty worktrees with a live session in `classify`; expose the new optional `onlyUnder` field on the dirty `TreeState` variant.
