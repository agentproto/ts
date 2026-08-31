---
"@agentproto/catalog-sync": patch
---

Test: Replace exact entry count assertion with floor check to prevent blocking automated catalog sync PRs when providers add or remove models. Maintains defensive check against silent data loss while tolerating normal single-digit drift.
