---
"@agentproto/runtime": patch
"agentproto-vscode": patch
---

Fix by-model-router adapters (hermes, pi, opencode) to stamp the resolved billing gateway onto the session descriptor's `route` field, preventing false "restart required" alerts in the VS Code change-model picker.
