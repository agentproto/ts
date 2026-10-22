---
"@agentproto/runtime": minor
"@agentproto/worktree": minor
---

Add the `session_transcript` MCP tool for reading a session's normalised conversation from the daemon's events transcript (with an optional tail `limit`), and add `resolveWorktreesTurboConcurrency` / `WORKTREES_TURBO_CONCURRENCY_ENV` so provisioned worktree setup hooks run turbo with a bounded concurrency.
