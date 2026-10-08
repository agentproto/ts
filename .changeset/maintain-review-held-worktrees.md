---
"@agentproto/apps": minor
---

The repo-maintenance `maintain` workflow now also reviews branches held only because they're checked out in an idle, clean linked worktree with no open PR (tip at least 3 days old). Until now `worktree_gc` held such a worktree because its branch wasn't provably merged, and `branch_gc` held the branch because a worktree had it checked out, so an abandoned worktree was never reviewed and stayed forever. These branches now join the existing reviewer queue (same small/large model roles, verdict store, re-prompt and retry). The reviewer prompt says why the branch was held. The report gains a "Held worktrees reviewed" section listing each verdict, plus the `agentproto worktree rm <path>` command when the reviewer agreed nothing of value is lost. Nothing is removed automatically. The new `reviewHeldWorktrees` input (default `true`) turns it off.
