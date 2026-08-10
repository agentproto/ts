---
"@agentproto/runtime": minor
---

Add standalone HTTP routes for app UI hosting: `GET /apps/:appId/ui` serves installed apps' HTML with a REST bridge injected, and `POST /apps/:appId/tool-call` is the REST twin of the MCP `app_tool_call` gateway. Exports `performAppToolCall` and `injectStandaloneAppBridge` for shared use between MCP and HTTP surfaces.
