---
"@agentproto/cli": minor
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Implement adapter installation API for harnesses: add `POST /adapters/:slug/install` HTTP route and `adapter_install` MCP tool to install not-yet-ready agent CLI adapters. Supports both acp-catalog CLIs (npm-global) and first-party workspace adapters (manifest install pipeline). VS Code extension UI integration with context-aware install button for installable harnesses.
