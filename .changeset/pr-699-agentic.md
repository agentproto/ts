---
"@agentproto/llm-endpoint": minor
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Add upstream credential linking and live testing:

- **@agentproto/llm-endpoint**: New API for per-upstream credential status (describeUpstreamStatus, collectUpstreamStatuses, testUpstream) and HTTP routes (GET /v1/upstreams, POST /v1/upstreams/:provider/test).
- **@agentproto/runtime**: New llm-endpoint-links-store for persisting upstream→profile links to ~/.agentproto/llm-endpoint-links.json, and new MCP tools (llm_endpoint_set_upstream_link, llm_endpoint_list_links).
- **agentproto-vscode**: New "Upstreams" tree grouping with inline test and link actions, profile picker QuickPick, and pending-restart annotations when persisted links haven't been applied yet.

Users can now map LLM provider upstreams to named auth-profiles (instead of bare env keys), manage those links via MCP, and test them live to verify credentials resolve correctly.
