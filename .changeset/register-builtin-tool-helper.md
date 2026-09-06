---
"@agentproto/runtime": patch
"@agentproto/mcp-server": patch
---

Add `registerBuiltinTool` to `@agentproto/mcp-server` and retrofit the daemon's migrated builtin MCP tools (agent/app/task/session/orchestration/browser/llm-endpoint/auth/tunnel lists) onto it, collapsing the repeated defineTool + implementTool + defineDriver + toMcpTool boilerplate. Pure refactor — registered tool ids, schemas, transformers, and behavior are unchanged.
