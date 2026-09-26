---
"@agentproto/runtime": patch
"@agentproto/workflow-runtime": patch
---

App workflow agent steps get three defaults they were missing (F25-F27 from the agent-apps-dogfood friction log). `workflow_run_file`/`startFromFile` without an explicit `cwd` now defaults agent-step (and run-level) spawns to the owning app's root, falling back to the daemon's active workspace — never a bare `/` — and records the resolved cwd on the run. `resolveAgentRefsForWorkflow` now honours, in order, a step's own `adapter:`, the AGENT.md's `metadata.adapter`/`metadata.harness` override, a model-based default (`claude-*` models run on `claude-code`), then the old blanket `mastra-agent` default, and forwards the AGENT.md's `model` to the spawn when the step sets none; a step-level adapter override no longer leaks `options` shaped for a different adapter. A declared `outputSchema` is now announced on an agent step's FIRST prompt (compact JSON Schema, or a short field list when unconvertible), not only on a rejected-reply retry.
