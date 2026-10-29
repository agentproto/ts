---
"@agentproto/runtime": minor
"@agentproto/sandbox-computer": patch
---

Sandbox lifecycle leak fixes: an explicit `agent_kill` now tears down a reuse-only box instead of leaving it paused, the periodic sandbox GC reaps paused dead-session rows past a configurable age bound (`AGENTPROTO_SANDBOX_GC_PAUSED_MAX_AGE_MS`), and gone-box reconnect failures are recognised via the shared sentinel. `@agentproto/runtime` also exports `DEFAULT_PAUSED_BOX_MAX_AGE_MS` and `parsePausedBoxMaxAge`. `@agentproto/sandbox-computer` logs the create deadline phase and controller rejection reason so a stuck spawn no longer fails silently.
