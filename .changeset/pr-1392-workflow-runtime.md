---
"@agentproto/workflow-runtime": minor
"@agentproto/runtime": minor
---

AIP-58 §3 Outcome rule (P2): an agent step's session can now call the `run_request_input` MCP tool to explicitly suspend the step as `input-required` — the turn simply ending, or its final message reading like a question, never suspends it. A declared-but-unsatisfied `outputSchema` now fails as `error.code = "missing-output"` (replacing a bare thrown error) with a `hint: "possible-input-request"` triage aid when the final message looked like a question; a step declaring no contract at all still succeeds unconditionally, with one load-time warning per step. Suspended workflow runs resume via the existing `workflow_escalation_resolve { runId, payload }`, validated against the suspend's own JSON Schema before the transition.
