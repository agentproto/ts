---
"@agentproto/runtime": patch
"agentproto-vscode": patch
---

Add session visibility features for parent-child session hierarchies: `childrenBusy` field counts descendant sessions mid-turn, enabling UI to show idle parents as "delegating" rather than truly idle; also adds "parked" state for idle sessions with watchers.
