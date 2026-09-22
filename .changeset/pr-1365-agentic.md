---
"@agentproto/runtime": minor
---

Support native and proxied app origins: `AGENTPROTO_PUBLIC_HTTP_ORIGIN` env override, `X-Forwarded-Proto` awareness in `requestHttpBaseUrl`, and injection of `window.__AGENTPROTO_BASEURL__` (with `__AGENTPROTO_UI_TRANSPORT__` tags) so standalone app bridges can reach the daemon through proxies.
