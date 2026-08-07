---
"@agentproto/driver-agent-cli": patch
---

Fix: unconditionally isolate CLAUDE_CONFIG_DIR for all claude-code spawns to prevent inheritance of ambient global MCP server configuration. Previously only isolated when a permission mode was explicitly requested, leading to production incidents where unscoped workers could self-spawn uncontrolled child sessions through circular MCP references. Now every claude-code spawn gets an isolated temporary config directory with explicit empty mcpServers, preventing the SDK from loading real ~/.claude.json. The permission-mode settings.json file write remains conditional on whether a mode was requested.
