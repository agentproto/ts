---
"@agentproto/runtime": minor
---

Add a `telegram` decide channel to the approvals engine: `decideTelegram` plus `POST /approvals/:id/decision/telegram`, gated by a shared bot-bridge bearer secret (`approvals.telegramBotSecret`) instead of `web_click`'s browser Origin check (a Telegram webhook callback has none). Structurally identical to `decideWeb` otherwise — same `ApprovalDecideEvidence` shape, same `click_through` signing method, same "is this approval still pending" + "was the credential right" gate. Off by default (unset secret), same convention as `web_click`'s empty `webOrigins`.
