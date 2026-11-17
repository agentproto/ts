---
"@agentproto/runtime": patch
---

`desktop_conversation_ask` review follow-ups: the wait loop no longer re-lists every conversation on each poll (it reuses the resolved one), returns the full reply when a turn adds more than 200 messages, and still recognises the answer when the transcript ends on a system line; the list/read calls receive only the fields they use.
