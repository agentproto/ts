---
"@agentproto/runtime": minor
---

`GET /sessions` and `GET /sessions/:id` accept `?fields=a,b,c` (same allowlist semantics as the `session_list` MCP tool; `id` always kept). `SessionDescriptor.archivedAt` is set by `archiveSession` and cleared by `unarchiveSession`; the `GET /sessions?since=` delta now lists in `removed` only the ids archived at or after `since`. On `GET /apps/:appId/ui/assets/:file`, `sw.js` is served with `service-worker-allowed: /apps/:appId/ui` and `cache-control: no-cache`; `.webmanifest` gets `application/manifest+json`.
