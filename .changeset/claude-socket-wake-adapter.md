---
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/sentinel": patch
"@agentproto/transcript-fixtures": patch
---

Add an opt-in `claude-socket` wake adapter for external Claude Code sessions. When `daemon.claudeSocketWake` is true, a level 2 or higher message (next-turn, steer) to a `cc:<session_id>` row is delivered directly to the idle Claude Code process over its per-session unix socket, using the two-frame auth/user wire protocol; the message is consumed rather than also parked in the inbox, so a later Stop/UserPromptSubmit hook cannot re-inject it. Level 1 (fyi), `bypassPermissions` targets, and missing, non-socket, or foreign-owned registration/socket/key all fall back to the existing inbox delivery and report the reason on the send result. The `Notification` hook now refreshes the external row's liveness (POST /sessions/:id/touch), and `hook install` registers it alongside the existing inbox hooks.
