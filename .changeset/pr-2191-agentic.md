---
"@agentproto/runtime": minor
---

Carry `allowPromptFrom` forward across `session_restart` / `session_continue_fresh`, apply it on the HTTP `POST /sessions/agent` spawn path, and add the operator-only `agent_set_operator_label` MCP tool for stamping a session's `operatorLabel` without a fresh root spawn.
