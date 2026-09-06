---
"@agentproto/runtime": minor
---

Implement AIP-15 rule 7: durable suspend points in workflows. A `kind: "suspend"` step now parks its run as "awaiting-input" with a persisted `awaitingSuspend` record, enabling resumption through external events via `workflow_escalation_resolve`'s suspend form. Runs survive daemon restarts; resumption after restart is explicit and marked failed with a clear reason.

New event types: `workflow:suspended` and `workflow:suspend-resumed`. New method: `WorkflowRunner.resumeSuspend()`. New optional field: `WorkflowRun.awaitingSuspend`.
