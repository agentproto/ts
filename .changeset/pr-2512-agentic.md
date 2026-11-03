---
"@agentproto/runtime": patch
---

Serve a plain `application/json` MCP response to hosts that send a JSON-only `Accept` header. The daemon's `/mcp` (plus `/mcp/orchestrator` and `/mcp/imported/<id>`) and the standalone app MCP server previously bounced `Accept: application/json` with 406 "Client must accept both application/json and text/event-stream", and answered SSE-mode by default; a JSON-only MCP Apps host could not initialize or make a follow-up `tools/call`. Both servers now widen a JSON-only `Accept` before handing the request to the SDK transport (POST only, `rawHeaders` included) and enable `enableJsonResponse` so the body is JSON-RPC. Clients that already accept `text/event-stream` keep the SSE path unchanged, and a missing `Accept` still gets the SDK's 406.
