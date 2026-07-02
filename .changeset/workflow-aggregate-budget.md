---
"@agentproto/workflow-runtime": minor
"@agentproto/runtime": minor
---

Workflow runs gain a run-level cost ceiling: `RunWorkflowArgs.maxTotalCostUsd` sums each
spawned session's cost (via the host's new `readCostUsd`) and fails the next AgentStep
spawn with `budget_exceeded` once the total crosses the cap. Complements the per-session
`maxCostUsd`. (MCP `workflow_start`/`workflow_status` surfacing is a follow-up.)