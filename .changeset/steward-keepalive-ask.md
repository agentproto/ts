---
"@agentproto/apps": patch
---

Session steward: a `keepAlive` session can now be closed. With `askSessions`, a keepAlive session idle at least `keepAliveAskAfterMinutes` (default 240) whose worktree is merged or clean (nothing uncommitted, nothing ahead of base) is asked `STEWARD: DONE / NOT-DONE` like any other idle session, and a declared DONE closes it through `session_wrapup_apply`. Before, `buildAskQueue` skipped every keepAlive session, so an idle keepAlive session stayed `judge` forever whenever Jev stayed under `minConfidence`. keepAlive keeps meaning "re-light after a daemon restart"; an unknown worktree, uncommitted work or unmerged commits keep the session out.
