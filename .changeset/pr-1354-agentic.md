---
"@agentproto/catalog-sync": patch
"@agentproto/provider-kit": patch
"@agentproto/adapter-mastra-agent": patch
---

Tolerate `description: null` from the live Replicate API in the image:replicate generator, coercing it to an empty string instead of failing validation. Also test-only updates in provider-kit mocks and a type-cast adjustment in the mastra adapter.
