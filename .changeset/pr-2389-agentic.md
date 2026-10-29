---
"@agentproto/runtime": minor
---

`agent_start` and `POST /sessions/agent` gain a single `agent` reference that resolves an AGENT.md path, an agent id, or a role name through `resolveAgentRef`; `agentId` and `agentPath` keep working as aliases. `role` is now a deprecated alias of `agent` (announced in the spawn result warnings) and will be removed in `@agentproto/runtime` 6.0.0.
