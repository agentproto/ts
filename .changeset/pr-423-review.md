---
"@agentproto/driver-agent-cli": patch
---

Fix session.cancel() to delegate to arm.cancel(turnId) instead of aborting the connection-level controller
