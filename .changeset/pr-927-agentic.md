---
"@agentproto/app-kit": patch
"@agentproto/cli": minor
---

Add `agentproto app serve` command for serving app UIs as standalone webapps with MCP connectivity. Introduces optional `ui.port` field to AppUiDefinition, implements a static HTTP server with bridge script injection, and establishes MCP client proxying through a reserved `/__agentproto/tool-call` endpoint.
