---
"@agentproto/apps": patch
---

Session steward: a `keepAlive` session can now be closed. With `askSessions`, a keepAlive session whose worktree is merged or clean (nothing uncommitted, nothing ahead of base) is asked `STEWARD: DONE / NOT-DONE` like any other idle session, and a declared DONE closes it through `session_wrapup_apply`. Before, `buildAskQueue` skipped every keepAlive session, so an idle keepAlive session stayed `judge` forever whenever Jev stayed under `minConfidence`. Closing is an active act, so an on-demand run (`agentproto steward --ask-sessions`) applies no idle delay beyond `--idle`. Only a scheduled run (new `recurring` input, set by the hourly routine) waits `keepAliveAskAfterMinutes` (new input, default 1440, 0 disables), so a session its owner meant to resume is not closed overnight. keepAlive keeps meaning "re-light after a daemon restart"; an unknown worktree, uncommitted work or unmerged commits keep the session out.
