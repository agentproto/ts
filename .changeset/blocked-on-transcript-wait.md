---
"@agentproto/runtime": patch
---

Deflake the `session-blocked-on` transcript assertions: wait for the
`turn-end` record to land in `events.jsonl` instead of sleeping a fixed
50 ms, which raced the write-stream open on slower CI runners (ENOENT).
