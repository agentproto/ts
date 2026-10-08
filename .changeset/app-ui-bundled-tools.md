---
"@agentproto/runtime": minor
---

`app_tool_call` (and `POST /apps/:appId/tool-call`) can now run an app's own bundled tools: an id in the app's `ui.tools` allowlist that matches one of its `.agentproto/tools/<id>/TOOL.md` contracts is executed through the app's `.agentproto/drivers/*/DRIVER.md` implementations (AIP-30 `runTool`), the same pair workflows already use. Other ids still go to the daemon tool dispatch or `imported:<alias>/<tool>`.
