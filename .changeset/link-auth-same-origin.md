---
"@agentproto/runtime": patch
---

`POST /apps/:appId/link-auth` accepts a same-origin browser POST: an `Origin` equal to the origin the request was reached at (for example a tunnel hostname) no longer needs to be in `daemon.allowedOrigins`, so a Telegram session link works on a freshly provisioned tunnel. The route stays gated by the link token plus Telegram `initData`; any other cross-origin `Origin` still gets `403 forbidden_origin`, and no other route changes.
