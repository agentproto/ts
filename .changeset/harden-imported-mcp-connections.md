---
"@agentproto/runtime": patch
"@agentproto/plugin-local-browser": patch
"@agentproto/cli": patch
---

Harden imported-MCP connections (P0). `imported-mcps.json` is now written mode 0600 by every writer (runtime `saveImportedMcps`, plugin-local-browser register/unregister). The daemon proxy expands `${VAR}` in upstream headers (parity with the apps-host pool). A 401/403/unauthorized/forbidden failure now drops the upstream client so the next call reconnects, in both `McpProxyRegistry` and `McpClientPool`. New shared `resolveImportConnection` (`mcp-import-resolve.ts`) feeds both the proxy and the apps-host resolver. `McpCredentialDeps` gains `resolveMcpSecret` / `storeMcpSecret` seams (wired to the keychain in `serve`, unused until a later phase).
