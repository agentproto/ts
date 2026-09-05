---
"@agentproto/cli": patch
---

Fix allowlist validation for app_tool_call meta-calls: unwrap the inner tool name before checking against ui.tools allowlist, matching the daemon's behavior.
