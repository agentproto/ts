---
"@agentproto/runtime": minor
---

Fix PR provenance attribution to prefer explicit caller session ID over heuristic guess, eliminating misattribution when unrelated sessions share the same working directory. Add `workspaceSlug` field to disambiguate workspace roots from per-branch worktrees in PR footer labels.
