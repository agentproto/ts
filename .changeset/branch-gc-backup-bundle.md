---
"@agentproto/worktree": minor
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

branch gc: an apply with `includeReviewed` that deletes unmerged refs first writes one `git bundle` of those tips (`restore-<ts>.bundle` next to the restore log, refs first, `^<base>` last), verifies it and checks that every tip is in it. Its path is recorded in the restore log (`bundle`), the apply result and `applySummary.bundle`. If the bundle cannot be written or verified, the apply is refused: every confirmed ref is reported `failed` and nothing is deleted. Before this, deleting an unmerged remote branch left only shas that become unreachable on the remote.
