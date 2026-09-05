---
"@agentproto/runtime": minor
---

Additive read pagination: `file_read` gains offset/limit (lines for utf8, bytes for base64) plus a truncated flag, `directory_list` gains limit/cursor paging, and `conversation_read` gains lastN/cursor transcript windowing — all defaults unchanged.
