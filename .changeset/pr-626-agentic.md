---
"@agentproto/worktree": patch
---

Ship opt-in AIP-41 routine for scheduled worktree garbage collection. The `worktree-gc` routine wraps the existing `worktree_gc` engine and packages it as a reference template for users to adopt on a daily cron schedule. Routine ships disabled by default; activate in a workspace by copying to `.routines/` and setting `enabled: true`.
