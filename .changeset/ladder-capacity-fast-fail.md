---
"@agentproto/sandbox": patch
"@agentproto/sandbox-computer": patch
"@agentproto/runtime": patch
---

A placement-ladder rung that has a next rung no longer sits out the computer fleet's 12 minute `503 fleet-capacity` wait. The runtime passes the new `SandboxBootOpts.capacityWaitBudgetMs` (the rung's `agentStartTimeoutMs`, default 5 minutes) to every non-final rung; the computer provider then fails the rung at once when the refusal has no `Retry-After`, or waits once, capped by that budget, when it has one. The refusal reason (for example `no-active-host`) stays in the failure message and in the `[placement]` log line. A plain `sandbox` spawn and the last rung keep the existing wait.
