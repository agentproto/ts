---
"@agentproto/runtime": patch
---

Fix catalog eligibility parity with the spawn wallet guard (SPEC §1c). `buildCatalogModels` now gates gateway-only models on direct (fixed-wallet) vendor routes, preventing 500 errors at spawn time when the model's actual serviceable routes differ from the route's billed wallet.
