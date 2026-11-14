---
"@agentproto/runtime": patch
---

transcript_search and transcript_read refuse an unknown session ref instead of falling back on the caller, honour the total character cap across the lineage, and apply `since` to the target session's transcript only.
