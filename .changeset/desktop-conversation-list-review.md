---
"@agentproto/runtime": patch
---

`desktop_conversation_list` follow-ups from review: a missing `node:sqlite` (Node before 22.5) no longer fails the whole list, only the Codex half is skipped; the docs now say a Claude chat that has not run a turn yet is not listed, and that a renamed Codex state file yields no Codex rows.
