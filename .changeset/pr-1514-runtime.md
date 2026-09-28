---
"@agentproto/runtime": minor
---

Fix workflow_cancel: a still-running step is finalized to a `cancelled` status instead of being left `running` forever, an in-flight agent session that was still spawning when cancel fired is killed immediately, and a step interrupted mid-flight is never journaled as succeeded so `workflow_retry` re-executes it.
