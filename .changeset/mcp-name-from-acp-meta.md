---
"@agentproto/acp": patch
"@agentproto/mcp-app-host": patch
---

fix(acp): surface the canonical MCP tool name (`mcp__<server>__<tool>`) from `_meta.claudeCode.toolName` instead of the bridge's "<server>: <tool>" display title, so chat UIs can route MCP App views for claude-code sessions. fix(mcp-app-host): emit `object-src 'none'` in the sandbox CSP as the MCP Apps spec requires.
