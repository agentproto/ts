---
"@agentproto/worktree": minor
"@agentproto/cli": minor
"@agentproto/runtime": patch
---

Worktrees no longer fill the disk with per-worktree pnpm copies. Setup hooks now run against one pnpm store per worktrees pool (`<root>/<repo>/.pnpm-store`, same volume as the worktrees; override with `AGENTPROTO_WORKTREES_PNPM_STORE_DIR`) with `package-import-method=clone-or-copy`, so packages are cloned instead of copied. Removing a worktree also deletes its own out-of-tree pnpm virtual store (only a real directory named like the worktree that looks like a pnpm virtual store and holds no `.git`), and can prune the shared store in the background (opt-in: `AGENTPROTO_WORKTREES_PNPM_STORE_PRUNE=1`). `worktree new` warns when `worktrees.root` is on a nearly full system disk, and the `worktrees.root` help and the worktree README document how to move it.
