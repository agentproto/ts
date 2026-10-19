---
"@agentproto/runtime": patch
---

test(runtime): deflake `registry.recordNotice` — wait for the notice record itself, not just for `events.jsonl` to exist (the write stream creates the file empty before its first queued write lands).
