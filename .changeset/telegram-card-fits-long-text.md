---
"@agentproto/runtime": patch
---

Telegram approval cards show long text instead of cutting it at 500 characters per field. The approvals card now allows 3000 characters per field and 3800 for the body, and the permissions card applies the same 3800 cap to the whole message, so a card and its closing line stay under Telegram's 4096-character limit. When the approvals card is too long only its head is cut, so the Session and Expires lines stay visible.
