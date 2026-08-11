---
"@agentproto/runtime": patch
"agentproto-desktop": patch
"agentproto-vscode": patch
---

Settle orphaned tool calls at turn-end. Adapters like Hermes can end a turn while omitting tool-result events for nested/parallel calls, leaving them stuck in "pending" state in UI consumers. This change synthesizes tool-result events with null values before the turn-end is recorded, ensuring transcript replay sees completed tool cards.
