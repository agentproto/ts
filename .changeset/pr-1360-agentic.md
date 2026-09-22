---
"@agentproto/catalog-sync": patch
---

Switched the image:replicate generator source to the curated `collections/text-to-image` Replicate endpoint and filter fetched models to the curated roster, failing fast if none are present.
