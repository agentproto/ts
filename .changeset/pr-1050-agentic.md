---
"@agentproto/runtime": patch
---

Fix profile-aware route fallback for model-derived API key adapters: when a model's naive prefix-guessed route doesn't make a named profile eligible, search the model's actual serviceable routes for one that does, allowing models like "deepseek/deepseek-v4-flash" (billed via "openrouter") to work with appropriate profiles without requiring explicit `route.gateway`.
