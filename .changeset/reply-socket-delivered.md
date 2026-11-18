---
"@agentproto/runtime": patch
---

message_reply: a message delivered to an external (Claude Desktop) session over its Claude Code socket is now recorded as received, so the chat can `message_reply` to a `desktop_conversation_ask` instead of getting `unknown_message`.
