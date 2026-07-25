---
agentproto-vscode: minor
---

Add route-aware model selection to the VS Code extension. The change model picker now shows which route (gateway/provider) each model uses and flags cross-route switches as restart-required. A synthetic "Change route" row delegates to the new `configureSessionAxis` command for independent gateway selection. Refactor sessionConfig.ts to support targeting a specific configuration axis.
