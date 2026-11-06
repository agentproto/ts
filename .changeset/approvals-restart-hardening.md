---
"@agentproto/runtime": patch
---

Approvals now survive a daemon restart. Telegram approval cards are persisted next to the approval (`telegram-card.json`), so a tap on a card sent before the restart still decides, and a card whose approval was decided while the daemon was down is closed once at start. A Bureau decision lost between the engine saving it and the outbox write is relayed by a boot sweep (decided, no outbox entry, no `relayed.json` marker, Bureau request not yet expired). Telegram bridge errors now reach the daemon log as `[approval-telegram-bridge]`. The shared MCP Apps bridge ignores messages whose sender is not the host window.
