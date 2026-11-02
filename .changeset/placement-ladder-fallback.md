---
"@agentproto/runtime": minor
---

Add `agent_start.placement`: an ordered ladder of sandbox rungs (each with optional model, access, preflight and turnRetry overrides). A rung that cannot place the box (failed preflight, capacity or overflow refusal, exhausted egress pool, boot failure before the agent started) is skipped for the next one; a failure after the agent started never advances. The descriptor records `placement` with every attempt, an exhausted ladder fails with `sandbox_placement_exhausted`, and `session_migrate` and fresh-box `session_restart` re-place from rung 1 and carry `preflight` and `placement`.
