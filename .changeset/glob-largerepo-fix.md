---
"@agentproto/worktree": patch
---

Fix `expandGlob` crashing with `RangeError: Maximum call stack size exceeded` on large repos: `walk` now skips `node_modules` (in addition to `.git`), and no longer spreads recursive results into `Array.push` (which overflowed the call stack once a subtree returned enough entries).
