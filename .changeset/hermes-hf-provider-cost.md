---
"@agentproto/runtime": patch
"@agentproto/adapter-hermes": patch
---

hermes on the Hugging Face gateway: the session descriptor now names `huggingface` as `adapterProvider` (was the manifest's `openrouter`), and cost is priced from the catalogue's per-model/provider HF route table. hermes' own bogus `estimated_cost_usd` for HF sessions (e.g. $4494 for 18k tokens) is ignored, and a model with no published price shows as unpriced instead of a wrong figure.
