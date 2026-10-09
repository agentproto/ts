---
"@agentproto/runtime": patch
"@agentproto/workflow-runtime": patch
---

`run.retry` seeds the retry's workspace with a copy of the original run's `scratch/` and `artifacts/`, so replayed steps' files (and any supervisor fix) are present. Journal output relocation no longer overwrites files already in the destination.
