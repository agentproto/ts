---
"@agentproto/model-catalog": patch
"@agentproto/catalog-sync": patch
---

Add MiniMax-M3.1-Flash pricing; keep first-party MiniMax rows (cache-write included) when a retired model leaves MiniMax's pricing page, or when the page is unreachable, instead of re-pricing them from OpenRouter.
