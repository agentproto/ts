---
"@agentproto/adapter-hermes": patch
"@agentproto/adapter-mastracode": patch
"@agentproto/adapter-pi": patch
---

**adapters/hermes:** Replace hand-maintained model allowlist with dynamic catalog-based menu from the shared provider catalog, keeping it in sync with all available OpenRouter and OpenAI models.

**adapters/mastracode:** Replace static model allowlist with dynamic catalog-based menu; add `modelDerivedApiKey: true` for correct billing-auth eligibility.

**adapters/pi:** Replace static model allowlist with dynamic catalog-based menu; add `modelDerivedApiKey: true` fixing moonshot profile eligibility (profile was rejected because `methodsForDirect()` returned empty without this flag).

