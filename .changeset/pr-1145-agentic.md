---
"@agentproto/cli": minor
---

Add remote MCP server support to `app serve`: new `--remote-mcp-url`, `--remote-mcp-auth`, and `--remote-app-id` flags (with env-var fallbacks) allow serving MCP-Apps dashboards from a remote MCP server instead of a local directory. Export new public APIs: `resolveRemoteMcpTarget`, `resolveRemoteAppResourceUri`, `readRemoteAppHtml`. Extend `createDaemonMcpClientGetter` with an optional `authToken` parameter for bearer-token authentication (backward compatible).
