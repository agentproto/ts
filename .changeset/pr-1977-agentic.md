---
"@agentproto/mcp-app-host": patch
---

Declare the `@agentproto/app-client` dev dependency so workspace type-checks build the display-mode export before checking MCP app host round-trip tests. All other changes in this PR are workflows, CI drivers, and root-level scripts, which are not published packages and require no version bump.
