---
"@agentproto/runtime": patch
---

Merge queued follow digests in place instead of stacking one per flush, retaining both batches across a daemon restart and capping merged events at 50.
