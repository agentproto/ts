---
"@agentproto/runtime": minor
---

Add per-call human approval for imported MCP tools. A `hold` rule in `.agentproto/hooks.json` matching an imported tool (for example `send_message` on agentpush) now parks the call as a real pending permission (`allow_once` / `reject_once`, fail-closed on timeout, session death and shutdown) before it reaches the upstream server; `deny` and `gate` rules are treated as the same human hold at this seam. New exports `ToolPermissionRequest` and `ToolPermissionOutcome`, new `SessionsRegistry.requestToolPermission`. An opt-in Telegram bridge (`approvals.permissionTelegramChatId` + `approvals.permissionTelegramUserIds`, plus `permissionTelegramAlias` and `permissionTelegramTools`) mirrors each pending permission on the configured tools to a chat with tap buttons and routes the tap back to the permission, through callback_query updates on a signed telegram inbound endpoint. With no hold rule and no bridge config, behaviour is unchanged.
