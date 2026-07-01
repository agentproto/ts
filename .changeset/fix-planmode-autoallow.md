---
"@agentproto/driver-agent-cli": patch
---

Fix plan-mode sessions silently auto-approving the exit-plan-mode escalation, which let a `mode:"plan"` session write files despite the requested mode
