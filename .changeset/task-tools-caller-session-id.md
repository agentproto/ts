---
"@agentproto/runtime": patch
---

Attribute task tools called on the root `/mcp` via `?callerSessionId=` to that session instead of the operator, and add `defaults.tasks.operatorDelegates` to keep the ledger's operator rights for explicitly listed sessions.
