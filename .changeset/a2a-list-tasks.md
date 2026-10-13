---
"@agentproto/runtime": minor
---

`ListTasks` on the A2A app task endpoint pages through an app's tasks newest first, with `contextId` / `status` / `statusTimestampAfter` filters, `pageSize` (1–100, default 50) + opaque `pageToken` paging, `historyLength` trimming, and artifacts kept only when `includeArtifacts` is true.
