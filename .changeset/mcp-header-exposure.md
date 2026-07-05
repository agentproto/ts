---
"@agentproto/secrets": minor
---

Add the `mcp-header` secret-exposure variant + `resolveMcpHeaderExposure`, resolving a credential-broker path into connect-time HTTP headers (with a CR/LF/NUL injection guard). Backs headless/cron MCP re-auth without an interactive prompt.
