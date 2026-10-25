---
"@agentproto/runtime": patch
---

Add `WorkflowRunner.dispose()` to stop trailing-flush and lease timers, unsubscribe bus listeners, and drain pending persistence writes.
