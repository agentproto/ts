---
"@agentproto/runtime": minor
---

Add an MCP Apps host service with three daemon tools (`mcp_app_ui_index`, `mcp_app_ui_read`, `mcp_app_tool_call`) that resolve a session's server alias (session → project → user → imports) and proxy app-UI resources and iframe-initiated tool calls through a new config-keyed MCP client pool. Also adds codex `config.toml` MCP discovery (`~/.codex/config.toml`, `<cwd>/.codex/config.toml`) and exports the shared client-pool / codex-config / resolver helpers.
