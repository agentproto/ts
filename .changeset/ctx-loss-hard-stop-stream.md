---
"@agentproto/runtime": patch
---

Keep a hard-stopped session's transcript to one stream: the final context-rescue notice is written before the close instead of reopening the writer afterwards.
