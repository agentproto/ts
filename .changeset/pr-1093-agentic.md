---
"@agentproto/catalog-sync": patch
"@agentproto/model-catalog": patch
---

Fix missing bare Anthropic model IDs in context-windows generator. Some Anthropic model generations age out of the live /v1/models listing into dated-only IDs (e.g., `claude-opus-4-5-20251101`), but the bare "latest" spelling (e.g., `claude-opus-4-5`) remains a valid, callable back-compat ID. The pricing generator already derives these bare IDs from their dated siblings, but the context-windows generator was missing this logic, which dropped them from listNativeModelIds and every adapter's native model menu. Now derived identically to pricing.
