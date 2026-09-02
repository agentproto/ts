---
"@agentproto/adapter-mastra-agent": minor
"@agentproto/runtime": minor
---

P7 deliverables 1 & 2: Generic daemon MCP tool proxy and multi-adapter app_run support.

Deliverable 1 closes the gap where app agents couldn't reach daemon tools outside a hand-curated set: a new daemon MCP tool proxy discovers and proxies any `tools/list`-exposed tool an AGENT.md declares, with automatic `appId` injection for `app_*` tools so models never need to know their own app id.

Deliverable 2 extends `app_run` to support adapters that declare no `agent` option (claude-code, hermes, codex, ...): the spawn is now built FROM the AGENT.md (frontmatter model + body-as-prompt) instead of pointed at a path, with backward compatibility for mastra-agent (which still gets the path-based behavior).
