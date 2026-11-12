---
"@agentproto/runtime": patch
---

A tap on the Telegram approval card now records the tapper's verified Telegram user id on the decision, and obeys `approvals.humanTelegramIds` when it is set: a tap from a user outside that owner list is refused with "Not authorised." for both Approve and Refuse.
