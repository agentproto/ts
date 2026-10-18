---
"@agentproto/runtime": patch
---

Slim the always-on MCP `tools/list` payload by advertising `agent_start`'s
(and five other always-on tools') rarely-used nested object options as opaque
values, with the real zod validation still enforced at call time and the full
sub-field detail moved to `docs/mcp-tools/*.md` fetched via `tool_help`.
