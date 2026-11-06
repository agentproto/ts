---
"@agentproto/clerk": patch
---

A clerk command's stderr is appended to `~/.agentproto/logs/clerk-<sessionId>.err` instead of being dropped, so a failing pass (exit 1) leaves a cause behind.
