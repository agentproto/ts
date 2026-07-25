---
"@agentproto/runtime": minor
---

Add provider-agnostic inbound webhook endpoints (`POST /inbound/:slug`) with signature verification for agentpush, telegram, whatsapp, slack, and generic platforms. Includes per-endpoint deduplication, MCP tools for endpoint management (`inbound_endpoint_create`, `inbound_endpoint_list`, `inbound_endpoint_delete`), and comprehensive error handling to prevent webhook provider retry loops.
