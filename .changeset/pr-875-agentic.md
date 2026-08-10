---
"@agentproto/adapter-hermes": patch
"@agentproto/runtime": minor
---

**adapters/hermes:** Replace hand-maintained model allowlist with dynamic catalog-based menu. Hermes now generates its allowed models from the shared provider catalog, keeping the menu in sync with all available OpenRouter and OpenAI models without manual updates.

**packages/runtime:** Add `injectMcpAppBridge()` function to inject the MCP App wire protocol bridge into served UI panel HTML. Every installed app's UI panel now includes the bridge at serve time, enabling all app UIs to communicate with the host via `window.McpApp.connect()` without shipping duplicate copies in each app.

