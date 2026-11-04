---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Add named MCP surface profiles (`core`, `orchestrator`, `apps`, `admin`,
`full`) selectable per request with `?profile=` or daemon-wide with
`defaults.mcp.profile`, plus a budget test that requires every generated
daemon tool to be classified.
