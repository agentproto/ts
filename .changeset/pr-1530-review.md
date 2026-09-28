---
"@agentproto/runtime": patch
---

Fix message_reply race where a just-acked message could miss its unflushed transcript record
