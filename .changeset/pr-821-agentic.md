---
"@agentproto/runtime": minor
"@agentproto/workflow-runtime": minor
---

Add progressive step status reporting to workflow execution via optional `onStepStart` and `onStepComplete` callbacks. Steps now transition through pending → running → done states during execution, rather than remaining pending until workflow completion. This enables real-time progress tracking for long-running workflows.
