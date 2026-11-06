---
"@agentproto/runtime": minor
---

Approvals engine records can now be decided from Telegram. With `approvals.telegramApprovalCards: true` and the existing `approvals.permissionTelegramChatId` / `permissionTelegramUserIds` set, each new approval (for example a Bureau recipe write) is sent to that chat as an Approve / Refuse card. A tap from an allowed user in that chat decides it through the `telegram` channel, and a decision or expiry from any other channel strips the buttons. The `telegram` channel is listed on new approvals only when the cards are on or `approvals.telegramBotSecret` is set.
