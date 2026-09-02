---
"@agentproto/harness": patch
"@agentproto/worktree": patch
"@agentproto/runtime": patch
---

Sandboxed sessions now report their spend, and PR footers pick it up.

- `HarnessClient.usage(sessionId)` (`session_usage`) and an optional `usage` on
  `DaemonAgentSessionHost`. The runtime's sandbox spawn wires it as the session's
  `readUsage` hook, so a box's cost/tokens/model reach the HOST descriptor at
  every turn-end — the proxy's text stream never carried them, which is why the
  CI review footer showed no amount and no model for e2b-sandboxed `claude-sdk`
  reviews.
- `readUsage` may now return `model`; a descriptor spawned without one adopts it.
- PR-body footer cost refresh: a PR opened through the daemon is stamped the
  instant `gh pr create` returns — mid-turn, before a claude-code/claude-sdk
  session has reported any cost. The provenance reconciler now re-renders each
  recorded PR's footer once the session knows its spend (`replaceProvenanceFooter`,
  `stampFooterOnPr({ refresh: true })`), exactly once per PR.
