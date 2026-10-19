---
"@agentproto/runtime": patch
---

test(runtime): deflake `registry.recordNotice` — the test now polls until the specific `notice` record is readable in `events.jsonl` instead of stopping at "file exists" (the write stream creates the file empty before its first queued write lands), removing a CI-only flake in `sessions-record-notice.test.ts`.
