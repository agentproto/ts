---
"@agentproto/model-catalog": minor
"@agentproto/catalog-sync": patch
---

Refresh provider-sourced model catalogs (OpenRouter, Requesty, HuggingFace, Moonshot, xAI) from live provider data: adds newly available models (e.g. claude-opus-5 and variants, gemini-3.5/3.6 entries) and updates pricing for existing entries. Data-only refresh via the existing catalog-sync generators; no adapter or routing logic changed.
