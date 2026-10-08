---
"@agentproto/runtime": patch
---

The public MCP events origin now runs as its own principal (`sessionPrincipal("mcp-events-origin")`) instead of the operator's daemon-bearer principal, so a holder of the events URL can no longer see or cancel the operator's subscriptions. A malformed percent-encoding in `/mcp/events/<secret>` answers 404, and OPTIONS on that route answers 405 with `Allow: POST`. `initialize` on the modern core is now a 404 `-32601` (naming the supported versions in `data`). The 2026-07-28 contract rows run as real tests, and `docs/mcp-events-integration.md` documents the events origin.
