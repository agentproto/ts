---
"@agentproto/runtime": minor
"@agentproto/worktree": patch
---

`branch_gc` can run in the background (`wait: false`, or `waitMs` to block at most that long) and be polled with the new `branch_gc_status` tool, so a multi-minute plan no longer times out an MCP call. Branch gc also answers "contained in a remote ref" and "merged into base" from one `git rev-list` each instead of one git call per ref (109 s → ~78 s on a 900-ref repo).
