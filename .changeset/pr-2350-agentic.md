---
"@agentproto/runtime": patch
---

Deliver must-wake follow events (awaiting-input, crashed, and a turn-end carrying a question) at least at `next-turn` even when the follow is `fyi`, so the always-wake set is never parked silently in the inbox.
