---
"@agentproto/workspace-brain": patch
---

Fix concurrent write race condition in brain-state.json persistence. Serialize all `record()`/`forget()` operations via an enqueue function and add per-call write counters to prevent file corruption when multiple ingests finish inside the same debounce batch.
