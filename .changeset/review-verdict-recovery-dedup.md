---
"@agentproto/review": minor
"@agentproto/runtime": minor
---

Review reliability: a reviewer that ends its turn without a valid verdict file now gets one bounded, passive recovery step inside the review workflow (`review.recoveryPresets` + the `review.recovery` model role; inert unless configured). A small tool-less model may recover the reviewer's own conclusion and findings (the daemon validates and writes the verdict file, never fabricates an approval from partial or errored analysis) or classify why the review failed; it is bounded by the lane's original deadline and cancel, keeps the OpenRouter guard, and is recorded apart from the reviewer as the lane's `recovery` field. Lanes whose fallback chains resolve to the same actual reviewer, rubric bytes, effective frozen range and options now share one run-scoped reviewer execution, marked with `sharedExecution` so they are not read as independent agreement. The agent-lane prompt states one consistent verdict rule with a schema-valid example. AIP-62 attestation lanes gain optional `recovery` and `sharedExecution`.
