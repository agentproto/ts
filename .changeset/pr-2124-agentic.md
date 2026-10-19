---
"@agentproto/worktree": minor
"@agentproto/runtime": minor
"@agentproto/apps": patch
---

Add an optional `operator` approval to branch verdicts: with `includeReviewed`, an operator block bypasses `branch_gc`'s deterministic line-coverage guard for the exact tip and the plan records who bypassed it. Also make verdict-store writes lossless under concurrency by serialising per-file writers in-process and committing each write with a unique temp file plus atomic rename.
