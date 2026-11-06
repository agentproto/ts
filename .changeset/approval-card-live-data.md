---
"@agentproto/runtime": patch
---

Approval cards fetch their data live. The `ui://agentproto/approval/pending` and `ui://agentproto/approval/<id>` resources are now templates with no approval data and no ticket, so a host that caches the UI still shows the current list. After the handshake the page calls the new app-only `approval_card_list` tool (cards surface only, never model-visible) for the pending approvals and a fresh ticket each, and refreshes on every tool result, after each decision, and every 30 s while visible.
