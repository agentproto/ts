---
"@agentproto/llm-endpoint": minor
---

Add opt-in inbound authentication to the proxy. `LLM_ENDPOINT_ACCESS_TOKENS`
gates every client→proxy request (`Authorization: Bearer` or `X-Proxy-Access`),
and an independent `LLM_ENDPOINT_EDGE_TOKENS` layer (`X-Edge-Auth`) can be
enforced both in-process and at the edge — the new `llm-endpoint print-waf-rule`
command emits the matching Cloudflare custom-rule expression. Both layers are
unset-means-open, so existing local deployments are unaffected. The upstream
provider key remains server-side and is never held by a client.
