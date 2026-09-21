---
"@agentproto/catalog-sync": patch
---

Tolerate `description: null` from the live Replicate API in the image:replicate generator, coercing it to an empty string instead of failing validation.
