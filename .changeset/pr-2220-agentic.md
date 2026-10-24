---
"@agentproto/runtime": patch
---

Extract the durable keyed-row file mechanics into a shared module and rewire the sentinel webhook outbox to use it, with no behavior change.
