---
"@agentproto/runtime": patch
---

The `/sessions/*` token gate now accepts a same-origin GET/HEAD from a daemon-served app UI page (`Sec-Fetch-Site: same-origin` plus a `Referer` under `/apps/` on the same host). Browsers send no `Origin` on a same-origin GET and loopback has no bearer, so session-chat opened at `http://127.0.0.1:<port>/apps/...` got a 401 on `GET /sessions/:id/attachments/:file` and cold-loaded images rendered broken. Agent-made artifact pages (`/sessions/:id/artifacts/:key/raw`) stay refused.
