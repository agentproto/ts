---
"@agentproto/cli": patch
---

`agentproto worktree new` prints the resolved shared turbo cache directory (non-JSON output only), so a manual `pnpm build` in the new worktree can export the same `TURBO_CACHE_DIR` and hit the cache.
