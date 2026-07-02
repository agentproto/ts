---
"@agentproto/runtime": minor
---

Extract the `agent_start` spawn logic (orchestrator scoped sub-gateway minting, `mcpServers` merge, hermes default-mcpServers safety net, depth/quota guards, cwd resolution) into a shared `spawnAgentSession` used by both the MCP `agent_start` tool and `POST /sessions/agent`. The HTTP route now parses `orchestrator`/`mcpServers` and reaches the same capability as the MCP tool (and, via the relay passthrough, so do remote/CLI callers). No change to the MCP tool's input/output shape.
