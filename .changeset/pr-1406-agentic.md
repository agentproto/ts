---
"@agentproto/acp": minor
"@agentproto/driver-agent-cli": patch
"@agentproto/plugin-local-browser": minor
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

stdio MCP-server entries now carry `args` and `env` end to end: the ACP schema, runtime tool/HTTP parsing, spawn and restart mount builders, the file-based config converter, and the VS Code client type all forward them instead of silently dropping them. The local-browser plugin additionally exports headless per-session browser helpers (`ensureChromeDevtoolsMcp`, `resolveChrome`, `buildHeadlessBrowserMcpEntry`, …) and `installChromeMcp` gains generic `pkg`/`binName` options.
