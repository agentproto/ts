---
"@agentproto/worktree": minor
"@agentproto/cli": minor
"@agentproto/runtime": patch
---

Make `worktree gc` and `worktree archive`/`rm` safe for unmerged commits. A detached HEAD is now reclaimed by `gc` only when its sha is proven in base (ancestor, squash, patch, or a merged PR's head) and is held otherwise; proven ones are reclaimed by default, so `maintain` handles them, and `--include-detached` stays accepted. `archive`/`rm` keep the branch unless it is proven merged into base (`--force` overrides), print the decision, and record it in `MANIFEST.json`. The `worktree --help` text for `archive` now states exactly what is preserved.
