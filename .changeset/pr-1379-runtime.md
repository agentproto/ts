---
"@agentproto/runtime": patch
---

Serve `GET /apps/:appId/ui/` (trailing slash) in the app UI host so a reload after the SPA router rewrites the address bar no longer 404s.
