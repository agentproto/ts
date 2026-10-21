---
"@agentproto/runtime": minor
---

Expose the unified permission decision point: `decide(principal, action, resource, context)` (exported as `decidePermission`) with the v1 action vocabulary and the read-only `permissions_explain` MCP tool, and route `message_send` / `message_reply`, `message_parent`, `POST /sessions/:id/messages` and the box parent relay through the same messaging ACL, enforced again at `registry.sendMessage` via the attached `Decision`.
