---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Stable, manually reorderable pinned order. Pinned sessions now carry a daemon-persisted `pinnedOrder`: new pins append at the end and a new message or update never reorders them. `POST /sessions/pinned/order` and the `session_reorder_pinned` MCP verb (subtree-scoped) set the order, emitting `session:pinned-reordered`; `agentproto sessions` sorts the pinned group by it. Legacy pins without an order sort after ordered ones, oldest first.
