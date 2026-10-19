---
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

Derive Desktop follow identity from per-call Codex thread metadata in the MCP bridge, using a request-local connection so concurrent chats cannot share identity, and report `external-inbox` delivery for external followers without claiming a Desktop wake.
