---
"@agentproto/runtime": patch
---

Ring buffer and artifact-ledger passthrough now read opencode's `{ output, metadata }` tool-result shape. Before, an opencode session showed no `[tool-result]` lines at all, and the CI reviewer lane's `::agentproto-artifact::` marker was never re-emitted, so the agentproto-run driver harvested `artifacts=[]` and the review footer degraded to "legacy fallback" even when the native lane had posted.
