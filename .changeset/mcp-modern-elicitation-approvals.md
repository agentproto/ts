---
"@agentproto/runtime": minor
---

Extend the MCP 2026-07-28 human gate to pending approvals and to runs parked for human input. A pending approval read through `approval_get` / `approval_wait` is projected as a `url` elicitation pointing at the configured human approval page (`approvals.uiBaseUrl`, never a credential in the link); an `accept` is only logged as a display acknowledgement and never decides or consumes the approval. An operator calling `workflow_status` on a run parked on a flat, non-secret input schema receives a `form` elicitation, and the reply resumes the run through its own resolver. Each surface has its own switch (`mcp.humanGateApprovals`, `mcp.humanGateRuns`).
