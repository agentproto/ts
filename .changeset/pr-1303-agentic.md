---
"@agentproto/apps": patch
"agentproto-vscode": patch
---

Fix builtin panels served standalone (`GET /apps/:appId/ui`) hanging on "Connecting to bridge…": `panelBridgeScript` now detects the standalone shape (`window.parent === window` plus a working `window.McpApp.connect`), short-circuits `initBridge()` with a default inline hostContext, and routes `callTool` through the injected standalone app bridge. The postMessage-host path is unchanged. Adds static script assertions in `@agentproto/apps` and real-jsdom coverage in `agentproto-vscode`.
