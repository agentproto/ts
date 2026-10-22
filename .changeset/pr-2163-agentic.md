---
"@agentproto/runtime": minor
"@agentproto/transcript-fixtures": patch
---

Messaging can now cross workspace boundaries: `defaults.messaging.peerGroups` links groups of workspace slugs so `message_send` / `message_reply` (and the HTTP typed-message route) may reach a session in a peer workspace without a tree edge, independent of `defaults.messaging.allowSameWorkspace`. The ACL decision is centralized in `resolveMessageAcl` and shared by both the MCP tools and `POST /sessions/:id/messages`; `transcript-fixtures` now accepts the `peer` relation in raw session-message envelopes.
