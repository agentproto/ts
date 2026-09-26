---
"@agentproto/driver-agent-cli": patch
---

`toFileBasedMcpServers` now forwards stdio MCP-server `args`/`env` into the mastracode file-based and in-process configs instead of silently dropping them.
