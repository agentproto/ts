---
"@agentproto/runtime": minor
---

Add `mcp.noCallerIdentity` (`block` | `ask` | `accept`, default `block`) so identity-less MCP clients can send a message as `claude-code`, and add `replyTo` on `message_send` for declared reply routing.
