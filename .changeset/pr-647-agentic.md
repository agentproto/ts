---
"@agentproto/cli": patch
---
Isolate machine-global test state to prevent race conditions when parallel worktrees run test suites concurrently. Replaces `Date.now()`-based temp directory naming and fixed port ranges with kernel-guaranteed unique resources (`mkdtemp` for directories, ephemeral ports for networking).
