---
"@agentproto/worktree": patch
---

`branch gc`: a tip with no history in common with base NOR with the re-root anchor (e.g. a ref fetched from another repo, like `refs/remotes/<other>/main`) now classifies `unmerged`/`unrelated` instead of crashing the whole plan with `git diff --raw … '' <sha>` on the empty `merge-base(anchor, tip)`.
