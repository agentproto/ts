---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Add an opt-in `claude-socket` wake adapter for external Claude Code sessions. When `daemon.claudeSocketWake` is true, a level 2 or higher message (next-turn, steer) to a `cc:<session_id>` row also wakes the idle Claude Code process over its per-session unix socket, using the two-frame auth/user wire protocol. Level 1 (fyi), `bypassPermissions` targets, and missing registration, socket or key all fall back to the existing inbox delivery and report the reason on the send result. The `Notification` hook now refreshes the external row's liveness (POST /sessions/:id/touch), and `hook install` registers it alongside the existing inbox hooks.
