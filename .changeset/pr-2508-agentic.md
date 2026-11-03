---
"@agentproto/adapter-claude-sdk": patch
---

Keep both MCP servers when a session carries two entries under one name. An orchestrator spawn mounts the daemon's full `/mcp` self-mount and the scoped `/mcp/orchestrator` gateway both named `agentproto`; the SDK's name-keyed `mcpServers` record previously kept only the second, dropping the full gateway and every app UI tool (`agentproto_work_board`, `app_ui_*`). Later same-named servers now get a numeric suffix instead of overwriting the earlier one.
