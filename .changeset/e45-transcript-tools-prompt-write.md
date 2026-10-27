---
"@agentproto/runtime": patch
---

Fix a flaky transcript read racing the prompt write. `sendPrompt` recorded the user prompt onto the transcript writer's in-memory stream buffer without tracking the flush, so a `transcript_search` / `transcript_read` issued right after the turn could observe events.jsonl without the prompt. The flush is now tracked through the registry's pending writes, so `settlePendingWrites()` gates reads on it like the other transcript writes.
