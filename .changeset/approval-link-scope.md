---
"@agentproto/runtime": minor
---

An approval link can read and decide exactly one daemon approval. A link-session token whose `approvalId` claim names an approval reaches `GET /approvals/:id` and `POST /approvals/:id/decision/telegram` for that id only, and decides through the `telegram` channel in place of the bot secret, when its verified `telegramUserId` is listed in the new owner-only config key `approvals.humanTelegramIds` (digits only, not writable through `config_set`, empty by default so approval links stay off). Every refusal is the same `403 approval_link_forbidden`, each request leaves an `approval-link:` audit line, and the decision record and `approval:decided` event carry the decider's `telegramUserId`. The bot bridge's `approvals.telegramBotSecret` path is unchanged.
