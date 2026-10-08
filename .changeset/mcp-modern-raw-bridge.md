---
"@agentproto/runtime": patch
---

Bridge the MCP 2026-07-28 core to the in-process server over raw JSON-RPC instead of an SDK client, so `server/discover` keeps the `events` capability and handler errors keep their exact message.
