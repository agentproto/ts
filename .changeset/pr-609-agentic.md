---
"@agentproto/runtime": minor
---

Add optional `hint` field to `session_monitor` MCP tool response. When a polling timeout occurs, the hint guides callers toward the uncapped `agentproto sessions wait` CLI command. Improve docstrings for `agent_start` and `session_monitor` tools to clarify CLI equivalents.
