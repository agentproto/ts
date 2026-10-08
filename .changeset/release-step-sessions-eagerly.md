---
"@agentproto/workflow-runtime": patch
---

Release agent-step sessions as soon as their top-level step finishes when no step in the workflow reuses a session (`sessionRef`). Previously every finished step's session stayed live until the run ended, so a run parked on an approval (or a long one) accumulated idle sessions. `compileWorkflow` now sets `RuntimeWorkflow.reusesSessions: false` for such workflows; hand-built workflows keep the old release-at-run-end behavior.
