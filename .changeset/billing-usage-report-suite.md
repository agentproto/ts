---
"@agentproto/billing": minor
---

Add `usageReport` (`@agentproto/billing/spend`): per-category charged, cost and real margin from shadow entries (one count per event key, unpriced events apart, categories under their `marginFloor` named, an opaque `credentialSource` split), and the BILL-USE conformance cases (`billingUsageConformanceCases`, `@agentproto/billing/testing`, AIP-74 rules 29 to 35). `usageProblems` now refuses a category that writes its own rate.
