---
"@agentproto/model-catalog": minor
"@agentproto/catalog-sync": minor
---

Add the Requesty LLM pricing catalog: a `catalog-sync` generator over
`https://router.requesty.ai/v1/models` emitting `REQUESTY_ROUTES` (553 routes
from a 563-model pinned snapshot), and a `requesty` branch in
`resolveLlmModelRoute` so `<vendor>/<product>@requesty` prices independently of
the direct vendor route — `sference/thinkingcap-qwen3.6-27b@requesty` → $0.4/$3
in, bare `openai/gpt-4.1` still → the direct OpenAI price.

`REQUESTY_ROUTES` is intentionally not spread into `LLM_PRICING_CATALOG`; that
map is the legacy bare-id path and a second router in it would repoint
direct-vendor ids at router pricing. `requesty` joins `CatalogProviderSchema`
and `PROVIDER_KEY_ENV`.
