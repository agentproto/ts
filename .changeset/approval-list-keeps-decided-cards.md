---
"@agentproto/runtime": patch
---

The pending approvals card list keeps a card it just decided on screen, reading "Approved" or "Refused" with no buttons, instead of dropping it at once. The memory lives only in the page; a reload starts empty. "Nothing to approve" shows only when no pending and no decided card is on screen.
