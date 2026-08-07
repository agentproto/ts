---
"@agentproto/app-kit": minor
"@agentproto/runtime": minor
---

Add app dependency management and scope mount tracking. Introduces `requires` field on apps to declare dependencies, new MCP tools (`app_apply`, `app_unapply`, `app_list_applied`) for managing app mounts to scopes, HTTP endpoints mirroring the tools, and AppRegistry enhancements for persistence of applied mounts with dependency validation.
