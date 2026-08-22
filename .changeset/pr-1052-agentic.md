---
"@agentproto/cli": patch
"@agentproto/runtime": patch
"@agentproto/worktree": patch
"agentproto-vscode": patch
---

Implement exit-time auto-reclaim for policy-provisioned (implicit) worktrees. When a session spawned under the `"always"` isolation policy without an explicit `worktree` request exits cleanly (merged/fresh, no uncommitted work), its worktree is automatically reclaimed using the same safety-layered classify→re-verify→remove pipeline as `worktree gc`. Caller-explicit worktrees (today's manual-cleanup behavior) are never auto-reclaimed. The feature is fire-and-forget, best-effort only, and never interrupts session teardown.
