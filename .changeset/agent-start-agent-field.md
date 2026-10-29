---
"@agentproto/runtime": minor
---

`agent_start` gains `agent` (an AGENT.md path, an agent id or a role name)
that resolves through one function; `agentId`, `agentPath` and `role` keep
working; `role` is a deprecated alias announced in the result `warnings` and
removed in 6.0.0.
