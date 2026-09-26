---
"@agentproto/app-client": minor
"@agentproto/apps": minor
"@agentproto/runtime": minor
"@agentproto/app-kit": patch
"@agentproto/skill-pack-agentproto": patch
"agentproto-vscode": patch
---

Unify the display-mode toggle into `@agentproto/app-client/display-mode`: the panel bridge and the `window.McpApp` bridges now share one installer with host-aware placement (`safeAreaInsets`), theme support, an `optimistic` mode, and `mountToggle` for inline placement. Runtime exports `injectMcpAppBridge` / `MCP_APP_BRIDGE_SCRIPT`; the bridges expose `getHostContext` / `onHostContext` / `displayMode`.
