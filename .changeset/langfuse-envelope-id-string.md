---
"@agentproto/telemetry-langfuse": patch
---

Fix Langfuse ingestion rejecting every event: the batch-envelope `id` must be a
string (Langfuse's idempotency key), not a numeric counter. Reuse each object's
unique body id as the envelope id so re-sends dedup correctly. Verified live
against a real Langfuse project (207, 0 errors, trace + scores queryable).
