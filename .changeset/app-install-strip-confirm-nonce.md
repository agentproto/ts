---
"@agentproto/runtime": patch
---

Confirming an `app_install` from an app panel's `window.McpApp` bridge no longer fails with an unknown-key error. The second call echoes the preview's `confirm` nonce, and `appInstallInputSchema` is strict, so `dispatchAllowlistedAppTool` now strips `confirm` from the args before dispatching to `dispatchTool` or an imported tool. Direct MCP/CLI `app_install` calls are unaffected.
