---
"@agentproto/worktree": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/apps": patch
---

`branch gc` gains two safety mechanisms. Orphan refs whose tip IS a base remote's `refs/pull/<N>/head` are classified `forge-mirror` and reclaimed without running the ladder (the forge keeps those refs forever, so the local ref is never the only copy), and their restore log re-fetches the PR head instead of `update-ref`. Separately, `includeReviewed` now refuses an agreeing verdict deterministically: the tip carries `lineCoverage` (the share of its non-trivial added lines already present verbatim in base's version of the same path), and an approval below `minLineCoverage` (default 95, configurable via `agentproto branch gc --min-line-coverage PCT`, the `branch_gc` MCP tool, and the daemon HTTP surface) leaves the ref `review` with `verdictGuard` / `refused-guard` rather than reclaiming it. The repo-maintenance reviewer prompt and review-queue builder surface `lineCoverage` so reviewers account for the missing lines.
