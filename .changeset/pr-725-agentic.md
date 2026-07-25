---
"@agentproto/runtime": patch
---

Fix race condition in resume-context-injection that caused CI flakes. Move digest building before banner writes to `events.jsonl` so the read doesn't race against asynchronous flush of transcriptWriter.recordEvent.
