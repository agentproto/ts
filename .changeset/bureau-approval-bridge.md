---
"@agentproto/runtime": minor
---

Bridge Bureau recipe-write approvals into the daemon. An `aip-59` import that returns `browser:approval_required` with `deviceDecision: true` now creates a `bureau.recipe-write` approval, adds `approvalId`/`waitWith` to the tool result, and mounts the standard approval card through `_meta.ui.resourceUri`. The human's decision is relayed to Bureau's `POST /pair/approvals/<requestId>` with the import's device credential (never a sub-session token).
