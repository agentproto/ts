---
"@agentproto/runtime": patch
---

Autocompact only injects the resume prompt when the session really had work in progress at compaction time, and the full-transcript pointer (`transcript_search` / `transcript_read`) is carried both on the compaction command for harnesses that accept instructions and as a one-shot note on the next prompt for the rest.
