---
"@agentproto/apps": patch
"@agentproto/runtime": minor
"@agentproto/worktree": minor
---

Branch gc prunes stale remote-tracking refs (`git fetch --prune`) before classifying and reports it as `plan.fetched`; its delete pushes skip git hooks (`--no-verify`) and a refused batch is retried as a batch before falling back to one push per ref. The `maintain` workflow now applies worktree gc before branch gc.
