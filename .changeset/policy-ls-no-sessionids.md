---
"@agentproto/cli": patch
---

`agentproto policy ls` no longer crashes with `TypeError: Cannot read properties of undefined (reading 'length')` on policies that carry only `sessionId` (no `sessionIds`). The SESSIONS column counts the fan-in group when present, else 1 for a single `sessionId`, else 0.
