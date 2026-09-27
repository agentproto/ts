---
"@agentproto/mcp-app-host": patch
---

Test-only: the `mountMcpApp` ui/initialize test now polls for the reply instead of sleeping a fixed 20ms, which flaked on loaded CI runners.
