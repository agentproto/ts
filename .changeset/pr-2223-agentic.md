---
"@agentproto/runtime": patch
---

Stamp `operatorLabel` on operator spawns made through `POST /sessions/agent`, matching the `agent_start` MCP tool so `label:` entries in `allowPromptFrom` apply to sessions that Pygmalion launches over HTTP.
