---
"@agentproto/runtime": minor
"@agentproto/worktree": patch
"@agentproto/tool": minor
---

`branch_gc` / `worktree_gc` daemon tools: smaller, truthful responses and a faster plan. `branch_gc_status` takes `classes`, `scopes`, `section`, `results`, `limit` and `cursor`, and `full: true` now returns one filtered page (default 100 rows, with `page.nextCursor`) instead of the whole 65k+ character result. An apply result carries a top-level `status` and an `applySummary` (deleted / skipped / failed per scope, plus the restore log path). A running job no longer announces a `resultPath` that does not exist yet. `terminal_sessions_list` called without `limit` is capped at 50 rows with `total` / `truncated` / `nextCursor`; `paginated()` gains a `defaultLimit` option for this. The branch gc ladder computes `git patch-id`s once per commit and reuses merge-bases instead of running `git cherry` per tip (about 2.5x faster on a 374-ref repo, identical classification).
