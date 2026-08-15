---
"@agentproto/runtime": minor
"@agentproto/workspace-brain": minor
---

Signal sources ingested with a stale pipeline version. Introduces `PIPELINE_VERSION` constant and `isStaleRecord()` helper to detect when ingested data was produced by an older version of the chunking/processing logic. When `ingestPending()` completes, it now reports `staleSources` (count of records behind the current pipeline version) and `currentPipelineVersion`. The new optional `reindexStale` parameter to `ingestPending()` forces re-ingestion of stale sources. Updated `workspace_brain_status` and `workspace_brain_ingest` tool descriptions to explain the new `staleSources` signal.

