---
"@agentproto/worktree": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Add `branch_gc`, the sibling of `worktree_gc` for refs. It classifies local branches, the base remote's branches and orphan tracking refs (from removed remotes) as `reclaim` (provably in base: merged, squash-merged, patch-merged or content-merged), `review` or `hold` (protected, worktree plus its remote twin, open PR, PR check unavailable, too young). It's a dry run unless you pass `apply` with explicit `scopes`. Each ref is re-classified right before it's deleted, and every apply writes a restore log. `branch_gc_verdict` stores reviewer verdicts by tip sha, so `includeReviewed` can reclaim a ref once a gate has agreed. New CLI commands: `agentproto branch gc` and `agentproto branch review-queue`; new HTTP routes: `POST /branches/gc[/verdict]`. `worktree_gc` also changes: a noise allowlist (`noisePaths`, default `.opencode/package-lock.json`), status reads that take no optional locks, and clean idle worktrees whose branch content is squash/patch/content-merged now reclaim.
